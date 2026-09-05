/**
 * Tool execution.
 *
 * Every tool call goes through here, and this layer — not the model — decides
 * what actually happened. It writes the authoritative `lastWriteOutcome` from
 * the HTTP response, drives state transitions, and refuses calls that would
 * require guessing on the caller's behalf.
 */
import { randomUUID } from 'node:crypto';
import { speakableLabel } from '@salon/core';
import { CrmError, type CrmClient } from '../crm/client.js';
import {
  addIntent,
  recordEvent,
  transition,
  type CallSession,
  type PendingConfirmation,
  type WriteAction,
} from '../session/types.js';
import { logger } from '../logger.js';

export interface ToolResult {
  /** Serialised back to the model as the tool result. */
  content: Record<string, unknown>;
  isError?: boolean;
}

type ToolInput = Record<string, unknown>;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

export class ToolExecutor {
  constructor(
    private readonly crm: CrmClient,
    private readonly session: CallSession,
  ) {}

  async execute(name: string, input: ToolInput): Promise<ToolResult> {
    const started = Date.now();
    try {
      const result = await this.dispatch(name, input);
      this.session.toolCalls.push({
        name, input, outcome: result.isError ? 'error' : 'success',
        latencyMs: Date.now() - started, at: new Date().toISOString(),
      });
      recordEvent(this.session, 'tool_call', { tool: name }, {
        latencyMs: Date.now() - started,
        outcome: result.isError ? 'error' : 'success',
      });
      return result;
    } catch (err) {
      const code = err instanceof CrmError ? err.code : 'INTERNAL_ERROR';
      const message = err instanceof Error ? err.message : String(err);

      this.session.toolCalls.push({
        name, input, outcome: 'error', errorCode: code,
        latencyMs: Date.now() - started, at: new Date().toISOString(),
      });
      recordEvent(this.session, 'api_error', { tool: name, code, message }, {
        latencyMs: Date.now() - started, outcome: 'error',
      });
      logger.warn({ callId: this.session.callId, tool: name, code }, 'tool call failed');

      return {
        isError: true,
        content: {
          error: code,
          message,
          guidance:
            'Tell the caller honestly that this did not work. Do not claim it succeeded. ' +
            'Offer another time, or take their details for a callback.',
        },
      };
    }
  }

  private dispatch(name: string, input: ToolInput): Promise<ToolResult> {
    switch (name) {
      case 'get_salon_info': return this.getSalonInfo();
      case 'list_services': return this.listServices(input);
      case 'resolve_time_expression': return this.resolveTime(input);
      case 'check_availability': return this.checkAvailability(input);
      case 'identify_caller': return this.identifyCaller(input);
      case 'find_appointments': return this.findAppointments(input);
      case 'select_appointment': return this.selectAppointment(input);
      case 'select_service': return this.selectService(input);
      case 'propose_booking': return this.proposeBooking(input);
      case 'propose_cancellation': return this.proposeCancellation(input);
      case 'propose_reschedule': return this.proposeReschedule(input);
      case 'commit_pending_action': return this.commit(input);
      case 'request_callback': return this.requestCallback(input);
      case 'end_call': return this.endCall(input);
      default:
        return Promise.resolve({
          isError: true,
          content: { error: 'UNKNOWN_TOOL', message: `There is no tool called ${name}.` },
        });
    }
  }

  private get ctx() {
    return { callId: this.session.callId };
  }

  // ── information ─────────────────────────────────────────────────────────────

  private async getSalonInfo(): Promise<ToolResult> {
    addIntent(this.session, 'hours');
    transition(this.session, 'FAQ', 'caller asked about the salon');
    const { salon, hours, policy } = this.session.context;

    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
      content: {
        name: salon.name,
        address: salon.address,
        phone: salon.phone,
        timezone: salon.timezone,
        openingHours: hours.week.map((d) => ({
          day: DAYS[d.dayOfWeek],
          hours: d.isClosed ? 'closed' : `${d.openTime?.slice(0, 5)}–${d.closeTime?.slice(0, 5)}`,
        })),
        upcomingClosures: hours.closedDates.slice(0, 5).map((c) => ({
          date: c.date,
          reason: c.reason,
          hours: c.openTime ? `${c.openTime.slice(0, 5)}–${c.closeTime?.slice(0, 5)}` : 'closed all day',
        })),
        bookingPolicy: {
          noticeRequired:
            policy.minLeadMinutes >= 60
              ? `${Math.round(policy.minLeadMinutes / 60)} hours`
              : `${policy.minLeadMinutes} minutes`,
          canBookUpTo: `${policy.maxAdvanceDays} days ahead`,
          cancellationWindow: `${policy.cancellationWindowHours} hours`,
          lateCancellationFee:
            Number(policy.lateCancellationFee) > 0
              ? `${policy.currency} ${policy.lateCancellationFee}`
              : 'none',
        },
      },
    };
  }

  private async listServices(input: ToolInput): Promise<ToolResult> {
    addIntent(this.session, 'services');
    transition(this.session, 'FAQ', 'caller asked about services');

    const category = asString(input.category)?.toLowerCase();
    const services = this.session.context.services.filter(
      (s) => !category || s.category.toLowerCase().includes(category),
    );

    return {
      content: {
        services: services.map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          durationMinutes: s.durationMinutes,
          price: `${s.currency} ${s.price}`,
          description: s.description,
        })),
      },
    };
  }

  private async resolveTime(input: ToolInput): Promise<ToolResult> {
    const expression = asString(input.expression);
    if (!expression) {
      return { isError: true, content: { error: 'MISSING_EXPRESSION', message: 'Pass the caller\'s own words.' } };
    }

    const resolved = await this.crm.resolveTime(expression, this.ctx);
    this.session.slots.requestedWindow = {
      from: resolved.from, to: resolved.to, interpretation: resolved.interpretation,
    };
    return {
      content: {
        interpretation: resolved.interpretation,
        from: resolved.from,
        to: resolved.to,
        isBroad: resolved.isBroad,
        guidance: 'Read the interpretation back so the caller can correct it if you have it wrong.',
      },
    };
  }

  private async checkAvailability(input: ToolInput): Promise<ToolResult> {
    addIntent(this.session, 'availability');
    transition(this.session, 'AVAILABILITY', 'checking the diary');

    const serviceId = asString(input.serviceId);
    const timeExpression = asString(input.timeExpression);
    if (!serviceId || !timeExpression) {
      return {
        isError: true,
        content: { error: 'MISSING_INPUT', message: 'Both serviceId and timeExpression are required.' },
      };
    }

    const service = this.session.context.services.find((s) => s.id === serviceId);
    if (service) {
      this.session.slots.serviceId = service.id;
      this.session.slots.serviceName = service.name;
      if (!this.session.servicesDiscussed.includes(service.name)) {
        this.session.servicesDiscussed.push(service.name);
      }
    }

    const availability = await this.crm.getAvailability(
      { serviceId, timeExpression, staffId: asString(input.staffId), limit: 6 },
      this.ctx,
    );

    // The caller is told "no" and given options in the same breath.
    if (availability.slots.length === 0) {
      return {
        content: {
          available: false,
          interpretation: availability.requestedWindow.interpretation,
          reason: availability.unavailableReason,
          alternatives: availability.alternatives.map(slotForModel),
          guidance:
            availability.alternatives.length > 0
              ? 'Nothing free then. Offer two or three of these alternatives.'
              : 'Nothing free then and nothing nearby. Ask what other days might suit.',
        },
      };
    }

    return {
      content: {
        available: true,
        interpretation: availability.requestedWindow.interpretation,
        slots: availability.slots.map(slotForModel),
        guidance: 'Offer two or three of these, not the whole list.',
      },
    };
  }

  private async identifyCaller(input: ToolInput): Promise<ToolResult> {
    transition(this.session, 'IDENTIFYING', 'identifying the caller');
    const name = asString(input.name);
    if (name) this.session.slots.customerName = name;

    if (this.session.callerPhone) {
      const customer = await this.crm.findCustomerByPhone(this.session.callerPhone, this.ctx);
      if (customer) {
        this.session.customer = {
          id: customer.id, firstName: customer.firstName, phone: customer.phone,
        };
        return {
          content: {
            known: true,
            firstName: customer.firstName,
            guidance: 'Greet them by first name. Do not read any other details back to them.',
          },
        };
      }
    }

    if (name) {
      const matches = await this.crm.searchCustomersByName(name, this.ctx);
      if (matches.length === 1) {
        const only = matches[0]!;
        this.session.customer = { id: only.id, firstName: only.firstName, phone: only.phone };
        return { content: { known: true, firstName: only.firstName } };
      }
      if (matches.length > 1) {
        return {
          content: {
            known: false,
            multipleMatches: matches.length,
            guidance: 'Several customers share that name. Ask for their phone number to be sure.',
          },
        };
      }
    }

    return {
      content: {
        known: false,
        guidance: 'New caller. Ask for their name, and their number if we do not have one.',
      },
    };
  }

  private async findAppointments(input: ToolInput): Promise<ToolResult> {
    addIntent(this.session, 'lookup');
    transition(this.session, 'LOOKUP', 'looking up appointments');

    const phone = asString(input.phone) ?? this.session.callerPhone ?? undefined;
    const customerId = this.session.customer?.id;
    if (!phone && !customerId) {
      return {
        isError: true,
        content: { error: 'NO_IDENTITY', message: 'Ask for their phone number first.' },
      };
    }

    const appointments = await this.crm.findAppointments(
      customerId ? { customerId, upcomingOnly: true } : { phone, upcomingOnly: true },
      this.ctx,
    );
    this.session.candidates = appointments;

    if (appointments.length === 0) {
      return { content: { count: 0, guidance: 'Nothing booked. Offer to book something.' } };
    }

    const summarised = appointments.map((a) => ({
      appointmentId: a.id,
      service: a.service.name,
      when: a.label,
      // Salon-local, so "the 10:30 one" is matched against a real local time
      // rather than by picking substrings out of a spoken label.
      localTime: a.localTime,
      localDate: a.localDate,
      with: a.staff.name,
    }));

    if (appointments.length === 1) {
      const only = appointments[0]!;
      this.session.slots.appointmentId = only.id;
      // Record its service: a follow-up "move it to Tuesday" must search
      // availability for *this* service, not whatever was last mentioned.
      this.session.slots.serviceId = only.service.id;
      this.session.slots.serviceName = only.service.name;
      this.session.slots.staffId = only.staff.id;
      this.session.slots.staffName = only.staff.name;
      return { content: { count: 1, appointment: summarised[0], requiresDisambiguation: false } };
    }

    // More than one. The agent must ask; guessing would cancel the wrong one.
    transition(this.session, 'DISAMBIGUATION', 'caller has more than one appointment');
    return {
      content: {
        count: appointments.length,
        appointments: summarised,
        requiresDisambiguation: true,
        guidance:
          'This caller has more than one appointment. You MUST ask which one they mean, ' +
          'describing each by service and time. Do not choose for them.',
      },
    };
  }

  /** Pin down which service the conversation is about. */
  private async selectService(input: ToolInput): Promise<ToolResult> {
    const serviceId = asString(input.serviceId);
    const service = this.session.context.services.find((s) => s.id === serviceId);
    if (!service) {
      return {
        isError: true,
        content: { error: 'SERVICE_NOT_FOUND', message: 'That service id is not on the menu.' },
      };
    }

    this.session.slots.serviceId = service.id;
    this.session.slots.serviceName = service.name;
    if (!this.session.servicesDiscussed.includes(service.name)) {
      this.session.servicesDiscussed.push(service.name);
    }
    addIntent(this.session, 'booking');
    // Choosing a service is only a booking signal if they are not already
    // moving something — "move it, and make it a colour" is still a reschedule.
    if (this.session.activeIntent !== 'reschedule') this.session.activeIntent = 'book';
    transition(this.session, 'COLLECTING', `caller chose ${service.name}`);

    return {
      content: {
        selected: true,
        serviceId: service.id,
        service: service.name,
        durationMinutes: service.durationMinutes,
        price: `${service.currency} ${service.price}`,
        guidance: 'Now ask when they would like to come in.',
      },
    };
  }

  /**
   * Pin down which appointment the conversation is about.
   *
   * Validated against the candidates we actually looked up for this caller, so
   * a stray id cannot be used to act on somebody else's booking — the same
   * guard the proposal tools apply.
   */
  private async selectAppointment(input: ToolInput): Promise<ToolResult> {
    const appointmentId = asString(input.appointmentId);
    if (!appointmentId) {
      return {
        isError: true,
        content: { error: 'APPOINTMENT_ID_REQUIRED', message: 'Pass the id of the appointment they chose.' },
      };
    }

    const chosen = this.session.candidates.find((a) => a.id === appointmentId);
    if (!chosen) {
      return {
        isError: true,
        content: {
          error: 'UNKNOWN_APPOINTMENT',
          message: 'That id was not one of the appointments we looked up for this caller.',
          guidance: 'Call find_appointments and use an id from its result.',
        },
      };
    }

    this.session.slots.appointmentId = chosen.id;
    this.session.slots.serviceId = chosen.service.id;
    this.session.slots.serviceName = chosen.service.name;
    this.session.slots.staffId = chosen.staff.id;
    this.session.slots.staffName = chosen.staff.name;
    // The ambiguity is resolved; narrowing the candidates stops the state block
    // continuing to insist the caller has two appointments to choose between.
    this.session.candidates = [chosen];
    transition(this.session, 'ROUTING', 'caller chose which appointment they meant');

    return {
      content: {
        selected: true,
        appointmentId: chosen.id,
        service: chosen.service.name,
        when: chosen.label,
        with: chosen.staff.name,
        guidance: 'Now carry on with what they wanted to do to it.',
      },
    };
  }

  // ── staging ─────────────────────────────────────────────────────────────────

  private stage(action: WriteAction, payload: Record<string, unknown>, restatement: string, appointmentId?: string): ToolResult {
    const pending: PendingConfirmation = {
      action,
      payload,
      // Minted once, here. Every retry of this action reuses it, which is what
      // makes a timed-out write safe to send again.
      idempotencyKey: `call-${this.session.callId}-${action}-${randomUUID()}`,
      restatement,
      stagedAt: new Date().toISOString(),
      stagedOnTurn: this.session.turnCount,
      ...(appointmentId ? { appointmentId } : {}),
    };
    this.session.pendingConfirmation = pending;
    transition(this.session, 'CONFIRMING', `${action} staged, awaiting confirmation`);
    recordEvent(this.session, 'confirmation_requested', { action, restatement });

    return {
      content: {
        staged: true,
        action,
        restatement,
        guidance:
          'Nothing has been changed yet. Say the restatement to the caller and wait for a ' +
          'clear yes. Only then call commit_pending_action.',
      },
    };
  }

  private async proposeBooking(input: ToolInput): Promise<ToolResult> {
    addIntent(this.session, 'booking');
    this.session.activeIntent = 'book';
    const serviceId = asString(input.serviceId);
    const start = asString(input.start);
    if (!serviceId || !start) {
      return { isError: true, content: { error: 'MISSING_INPUT', message: 'serviceId and start are required.' } };
    }

    const service = this.session.context.services.find((s) => s.id === serviceId);
    if (!service) {
      return { isError: true, content: { error: 'SERVICE_NOT_FOUND', message: 'That service id is not on the menu.' } };
    }

    const firstName = asString(input.customerFirstName) ?? this.session.customer?.firstName ?? this.session.slots.customerName;
    const phone = asString(input.customerPhone) ?? this.session.customer?.phone ?? this.session.callerPhone ?? undefined;

    if (!this.session.customer && (!firstName || !phone)) {
      return {
        isError: true,
        content: {
          error: 'NEED_CUSTOMER_DETAILS',
          message: 'We do not have this caller on file.',
          guidance: 'Ask for their first name and a contact number, then propose the booking again.',
        },
      };
    }

    const staffId = asString(input.staffId);
    const staffName = this.session.context.staff.find((s) => s.id === staffId)?.name;

    const payload: Record<string, unknown> = {
      serviceId, start, source: 'voice', callId: this.session.callId,
      ...(staffId ? { staffId } : {}),
      ...(this.session.customer
        ? { customerId: this.session.customer.id }
        : { customer: { firstName, phone } }),
    };

    const when = this.describeInstant(start);
    const restatement =
      `${service.name}, ${when}${staffName ? ` with ${staffName}` : ''}, for ${firstName ?? 'you'}` +
      `. That's ${service.currency} ${service.price}. Shall I book that?`;

    this.session.slots.serviceId = serviceId;
    this.session.slots.serviceName = service.name;
    if (staffId) this.session.slots.staffId = staffId;
    return this.stage('book', payload, restatement);
  }

  private async proposeCancellation(input: ToolInput): Promise<ToolResult> {
    addIntent(this.session, 'cancellation');
    this.session.activeIntent = 'cancel';
    const appointmentId = asString(input.appointmentId);

    // Refused at the tool layer, not left to the model's discretion: with more
    // than one appointment on file, a guess cancels the wrong one.
    if (!appointmentId) {
      return {
        isError: true,
        content: {
          error: 'APPOINTMENT_ID_REQUIRED',
          message: 'A cancellation must name exactly one appointment.',
          guidance: 'Call find_appointments, then ask the caller which one if there is more than one.',
        },
      };
    }

    // Must be one of the appointments we actually looked up for this caller —
    // an id from anywhere else would let the agent act on a stranger's booking.
    const appointment = this.session.candidates.find((a) => a.id === appointmentId);
    if (!appointment) {
      return {
        isError: true,
        content: {
          error: 'UNKNOWN_APPOINTMENT',
          message: 'That appointment id was not one of the ones we looked up.',
          guidance: 'Call find_appointments first and use an id from its result.',
        },
      };
    }

    const policy = this.session.context.policy;
    const hoursAway = (new Date(appointment.start).getTime() - Date.now()) / 3_600_000;
    const feeApplies = hoursAway < policy.cancellationWindowHours && Number(policy.lateCancellationFee) > 0;

    const restatement = feeApplies
      ? `Cancelling your ${appointment.service.name} ${appointment.label}. That's inside our ` +
        `${policy.cancellationWindowHours}-hour notice period, so there's a ` +
        `${policy.currency} ${policy.lateCancellationFee} late cancellation fee. Shall I go ahead?`
      : `Cancelling your ${appointment.service.name} ${appointment.label} with ${appointment.staff.name}. ` +
        `No charge. Shall I go ahead?`;

    const payload: Record<string, unknown> = {
      reason: asString(input.reason) ?? 'Cancelled by the customer over the phone',
      // Acknowledged up front only when the fee has been stated in the
      // restatement the caller is about to agree to.
      acknowledgeFee: feeApplies,
    };

    // Record the service too: if the caller switches to "actually, move it
    // instead", the reschedule needs to know what to search availability for.
    this.session.slots.appointmentId = appointmentId;
    this.session.slots.serviceId = appointment.service.id;
    this.session.slots.serviceName = appointment.service.name;
    this.session.slots.staffId = appointment.staff.id;
    this.session.slots.staffName = appointment.staff.name;
    return this.stage('cancel', payload, restatement, appointmentId);
  }

  private async proposeReschedule(input: ToolInput): Promise<ToolResult> {
    addIntent(this.session, 'reschedule');
    this.session.activeIntent = 'reschedule';
    const appointmentId = asString(input.appointmentId);
    const start = asString(input.start);
    if (!appointmentId || !start) {
      return {
        isError: true,
        content: {
          error: 'MISSING_INPUT',
          message: 'Both appointmentId and the new start time are required.',
          guidance: 'Use find_appointments for the id and check_availability for the new time.',
        },
      };
    }

    const appointment = this.session.candidates.find((a) => a.id === appointmentId);
    if (!appointment) {
      return {
        isError: true,
        content: { error: 'UNKNOWN_APPOINTMENT', message: 'Call find_appointments first and use an id from its result.' },
      };
    }

    const policy = this.session.context.policy;
    const hoursAway = (new Date(appointment.start).getTime() - Date.now()) / 3_600_000;
    const feeApplies = hoursAway < policy.cancellationWindowHours && Number(policy.lateCancellationFee) > 0;

    const serviceId = asString(input.serviceId);
    const service = serviceId ? this.session.context.services.find((s) => s.id === serviceId) : undefined;
    const when = this.describeInstant(start);

    const restatement =
      `Moving your ${service?.name ?? appointment.service.name} from ${appointment.label} to ${when}` +
      (feeApplies
        ? `. That's inside our ${policy.cancellationWindowHours}-hour notice period, so a ` +
          `${policy.currency} ${policy.lateCancellationFee} fee applies.`
        : '.') +
      ' Shall I move it?';

    const payload: Record<string, unknown> = {
      start,
      acknowledgeFee: feeApplies,
      callId: this.session.callId,
      ...(asString(input.staffId) ? { staffId: asString(input.staffId) } : {}),
      ...(serviceId ? { serviceId } : {}),
    };

    this.session.slots.appointmentId = appointmentId;
    this.session.slots.serviceId = service?.id ?? appointment.service.id;
    this.session.slots.serviceName = service?.name ?? appointment.service.name;
    return this.stage('reschedule', payload, restatement, appointmentId);
  }

  // ── the only write ──────────────────────────────────────────────────────────

  private async commit(input: ToolInput): Promise<ToolResult> {
    const pending = this.session.pendingConfirmation;
    if (!pending) {
      return {
        isError: true,
        content: {
          error: 'NOTHING_STAGED',
          message: 'There is nothing waiting to be confirmed.',
          guidance: 'Propose the action first, read it back, and get a clear yes.',
        },
      };
    }
    if (input.callerConfirmed !== true) {
      return {
        isError: true,
        content: { error: 'NOT_CONFIRMED', message: 'Only call this once the caller has explicitly agreed.' },
      };
    }

    recordEvent(this.session, 'confirmation_received', { action: pending.action });
    transition(this.session, 'EXECUTING', 'caller confirmed');

    try {
      const appointment = await this.performWrite(pending);

      // Authoritative: taken from the API's response, never from model text.
      this.session.lastWriteOutcome = {
        action: pending.action,
        result: 'success',
        appointmentId: appointment.id,
        appointmentLabel: appointment.label,
        at: new Date().toISOString(),
      };
      this.session.pendingConfirmation = null;
      this.session.consecutiveFailures = 0;

      // The diary just changed, so anything cached about it is stale. Leaving
      // the old candidates in place is how a cancelled appointment gets
      // proposed for rescheduling a moment later — which then fails on every
      // attempt, because it no longer exists.
      this.session.candidates = [];
      delete this.session.slots.chosenSlot;
      delete this.session.slots.requestedWindow;
      // The request is finished. Whatever they ask for next starts fresh.
      this.session.activeIntent = null;

      // The request is finished, so nothing about it should colour the next
      // one. Carrying the service forward made "book another — a blow dry"
      // re-book the service from the call before it; carrying the appointment
      // id forward made a fresh booking look like a reschedule. Whatever the
      // caller asks for next re-establishes its own context, and a lookup will
      // find this appointment again if they want to change it.
      delete this.session.slots.appointmentId;
      delete this.session.slots.serviceId;
      delete this.session.slots.serviceName;
      delete this.session.slots.staffId;
      delete this.session.slots.staffName;

      transition(this.session, 'RESULT_SUCCESS', `${pending.action} succeeded`);

      return {
        content: {
          success: true,
          action: pending.action,
          appointmentId: appointment.id,
          when: appointment.label,
          service: appointment.service.name,
          with: appointment.staff.name,
          guidance: 'This really did work. Confirm it warmly and ask if there is anything else.',
        },
      };
    } catch (err) {
      const error = err instanceof CrmError ? err : new CrmError('INTERNAL_ERROR', String(err), 500);
      this.session.consecutiveFailures += 1;

      // A timeout leaves us genuinely unsure — the write may have landed. Say
      // "unknown", never "failed", so the agent does not tell a customer their
      // booking failed when it may have succeeded.
      const indeterminate = error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR';
      this.session.lastWriteOutcome = {
        action: pending.action,
        result: indeterminate ? 'unknown' : 'failed',
        code: error.code,
        message: error.message,
        ...(Array.isArray(error.details?.alternatives)
          ? { alternatives: error.details.alternatives as never }
          : {}),
        at: new Date().toISOString(),
      };
      transition(this.session, 'RESULT_FAILED', `${pending.action} failed: ${error.code}`);

      // Keep the staged action only when retrying it could plausibly succeed —
      // a timeout, a 5xx, a rate limit. Retrying with the same key is the whole
      // point there, and the key must not change.
      //
      // For a definitive refusal, retrying is guaranteed to fail identically,
      // so the staging is thrown away and the agent has to propose something
      // new. Keeping it produced a loop in live use: the appointment was gone,
      // every retry failed, and the caller was asked "shall I go ahead?" over
      // and over.
      if (!error.retryable) {
        this.session.pendingConfirmation = null;

        // The appointment we were acting on is not in the state we believed.
        // Drop what we cached so the agent looks it up again rather than
        // proposing against a ghost.
        if (error.code === 'APPOINTMENT_NOT_MODIFIABLE' || error.code === 'APPOINTMENT_NOT_FOUND') {
          this.session.candidates = [];
          delete this.session.slots.appointmentId;
        }
      }
      const alternatives = Array.isArray(error.details?.alternatives)
        ? (error.details.alternatives as Array<{ label: string; start: string; staffId: string }>).map(slotForModel)
        : [];

      return {
        isError: true,
        content: {
          success: false,
          action: pending.action,
          error: error.code,
          message: error.message,
          ...(alternatives.length > 0 ? { alternatives } : {}),
          guidance: indeterminate
            ? 'We could not confirm whether this went through. Tell the caller honestly that ' +
              'you are not sure and that you will have someone check. Do not say it worked.'
            : alternatives.length > 0
              ? 'This did NOT happen. Say so plainly and offer one of these alternative times.'
              : 'This did NOT happen. Say so plainly and offer to take their details for a callback.',
        },
      };
    }
  }

  private async performWrite(pending: PendingConfirmation) {
    switch (pending.action) {
      case 'book':
        return this.crm.bookAppointment(pending.payload, pending.idempotencyKey, this.ctx);
      case 'cancel':
        return this.crm.cancelAppointment(
          pending.appointmentId!,
          pending.payload as { reason?: string | null; acknowledgeFee?: boolean },
          pending.idempotencyKey,
          this.ctx,
        );
      case 'reschedule':
        return this.crm.rescheduleAppointment(
          pending.appointmentId!, pending.payload, pending.idempotencyKey, this.ctx,
        );
    }
  }

  // ── escalation ──────────────────────────────────────────────────────────────

  private async requestCallback(input: ToolInput): Promise<ToolResult> {
    addIntent(this.session, 'callback');
    const name = asString(input.name);
    const phone = asString(input.phone) ?? this.session.callerPhone ?? undefined;
    const reason = asString(input.reason);

    if (!name || !phone || !reason) {
      return {
        isError: true,
        content: {
          error: 'MISSING_DETAILS',
          message: 'A callback needs a name, a number and what it is about.',
        },
      };
    }

    this.session.escalation = {
      reason,
      callback: { name, phone, reason, preferredTime: asString(input.preferredTime) ?? null },
    };
    transition(this.session, 'ESCALATION', 'handing over to a person');
    recordEvent(this.session, 'escalated', { reason });

    return {
      content: {
        captured: true,
        guidance: 'Confirm someone will call them back, and when. Then close the call politely.',
      },
    };
  }

  private async endCall(input: ToolInput): Promise<ToolResult> {
    transition(this.session, 'CLOSING', 'call ending');
    this.session.ended = true;
    return { content: { ended: true, farewell: asString(input.farewell) ?? 'Thanks for calling. Goodbye!' } };
  }

  /**
   * Salon-local, speakable rendering of an instant — "Friday 3 October at 2:30pm".
   *
   * Computed locally with the salon's timezone rather than sent to
   * `resolve_time_expression`: that endpoint parses *natural language*, and
   * feeding it an ISO timestamp makes it find "13:00" inside the string and
   * resolve to one o'clock today. Same reason the model never formats dates —
   * the arithmetic belongs in code that knows it is doing arithmetic.
   */
  private describeInstant(iso: string): string {
    if (this.session.slots.chosenSlot?.start === iso) return this.session.slots.chosenSlot.label;
    try {
      return speakableLabel(iso, this.session.context.salon.timezone, new Date().toISOString());
    } catch {
      return new Date(iso).toUTCString();
    }
  }
}

function slotForModel(slot: {
  start: string; label: string; staffId: string; staffName?: string;
  localTime?: string; localDate?: string;
}) {
  return {
    start: slot.start,
    when: slot.label,
    // Salon-local wall clock, which is the only sane thing to compare a
    // caller's "half nine" against. `start` is a UTC instant: during British
    // Summer Time the 10:30 slot carries T09:30, so matching a spoken time
    // against it books an appointment exactly one hour off.
    localTime: slot.localTime,
    localDate: slot.localDate,
    staffId: slot.staffId,
    with: slot.staffName,
  };
}
