/**
 * Twilio SMS client — sends outbound SMS and validates inbound webhooks.
 *
 * Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER
 * environment variables. Falls back to a no-op stub when credentials are
 * absent (fixture/demo mode).
 */

import Twilio from 'twilio';

export interface TwilioConfig {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
}

export interface SmsResult {
  ok: boolean;
  sid?: string;
  error?: string;
}

export class TwilioClient {
  private client: ReturnType<typeof Twilio> | null;
  private fromNumber: string;
  private authToken: string;
  private enabled: boolean;

  constructor(config?: TwilioConfig) {
    const accountSid = config?.accountSid ?? process.env['TWILIO_ACCOUNT_SID'] ?? '';
    const authToken = config?.authToken ?? process.env['TWILIO_AUTH_TOKEN'] ?? '';
    const fromNumber = config?.fromNumber ?? process.env['TWILIO_PHONE_NUMBER'] ?? '';

    this.authToken = authToken;
    this.fromNumber = fromNumber;

    if (accountSid && authToken && fromNumber) {
      this.client = Twilio(accountSid, authToken);
      this.enabled = true;
      console.log(`[twilio] SMS client initialized (from: ${fromNumber})`);
    } else {
      this.client = null;
      this.enabled = false;
      console.log('[twilio] SMS client disabled — missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER');
    }
  }

  /**
   * Send an SMS message.
   */
  async sendSms(to: string, body: string): Promise<SmsResult> {
    if (!this.enabled || !this.client) {
      console.log(`[twilio] (stub) Would send SMS to ${to}: ${body}`);
      return { ok: false, error: 'Twilio not configured' };
    }

    try {
      const message = await this.client.messages.create({
        to,
        from: this.fromNumber,
        body,
      });
      console.log(`[twilio] SMS sent to ${to} — SID: ${message.sid}`);
      return { ok: true, sid: message.sid };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[twilio] Failed to send SMS to ${to}:`, msg);
      return { ok: false, error: msg };
    }
  }

  /**
   * Validate an inbound Twilio webhook request.
   *
   * Twilio signs every webhook with the auth token — use this to reject
   * spoofed requests.
   */
  validateWebhook(
    signature: string,
    url: string,
    params: Record<string, string>,
  ): boolean {
    if (!this.authToken) return false;
    return Twilio.validateRequest(this.authToken, signature, url, params);
  }

  /**
   * Parse the body of a Twilio inbound SMS webhook.
   *
   * Twilio POSTs form-encoded data with keys like From, Body, MessageSid, etc.
   */
  static parseIncomingSms(body: string): { from: string; text: string; sid: string } | null {
    try {
      const params = new URLSearchParams(body);
      const from = params.get('From');
      const text = params.get('Body');
      const sid = params.get('MessageSid') ?? params.get('SmsSid') ?? '';

      if (!from || text == null) return null;
      return { from, text, sid };
    } catch {
      return null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getFromNumber(): string {
    return this.fromNumber;
  }
}
