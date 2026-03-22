import http from 'http';
import { URLSearchParams } from 'url';

import twilio from 'twilio';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { BlackboardPortal } from '../blackboard-portal.js';
import { ChannelOpts, registerChannel } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const SMS_JID_PREFIX = 'sms:';

// Twilio concatenated SMS max — splits here keep costs predictable
const SMS_CHUNK_SIZE = 1600;

export class SmsChannel implements Channel {
  name = 'sms';

  private client: ReturnType<typeof twilio>;
  private authToken: string;
  private fromNumber: string;
  private webhookPort: number;
  private webhookUrl: string;
  private myNumber: string;
  private server: http.Server | null = null;
  private portal: BlackboardPortal | null = null;
  private opts: {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
    onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;
  };

  constructor(
    accountSid: string,
    authToken: string,
    fromNumber: string,
    myNumber: string,
    webhookPort: number,
    webhookUrl: string,
    opts: {
      onMessage: OnInboundMessage;
      onChatMetadata: OnChatMetadata;
      registeredGroups: () => Record<string, RegisteredGroup>;
      onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;
    },
  ) {
    this.client = twilio(accountSid, authToken);
    this.authToken = authToken;
    this.fromNumber = fromNumber;
    this.myNumber = myNumber;
    this.webhookPort = webhookPort;
    this.webhookUrl = webhookUrl;
    this.opts = opts;
  }

  /** Attach the Blackboard portal so its routes are served on this webhook server. */
  setPortal(portal: BlackboardPortal): void {
    this.portal = portal;
  }

  async connect(): Promise<void> {
    // Auto-register the owner's number as the main group on first run
    if (this.myNumber) {
      const chatJid = `${SMS_JID_PREFIX}${this.myNumber}`;
      const existing = this.opts.registeredGroups()[chatJid];
      if (!existing && this.opts.onRegisterGroup) {
        const folder = phoneToFolder(this.myNumber);
        this.opts.onRegisterGroup(chatJid, {
          name: `SMS ${this.myNumber}`,
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          isMain: true,
        });
        logger.info(
          { chatJid, folder },
          'SMS: auto-registered owner number as main group',
        );
      }
    }

    this.server = http.createServer((req, res) => {
      // Blackboard portal routes take priority
      if (this.portal?.handleRequest(req, res)) return;

      if (req.method === 'POST' && req.url === '/sms') {
        this.handleWebhook(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.webhookPort, () => {
        logger.info({ port: this.webhookPort }, 'SMS webhook server listening');
        console.log(`\n  SMS channel ready`);
        console.log(`  Twilio number : ${this.fromNumber}`);
        console.log(`  Webhook port  : ${this.webhookPort}`);
        if (this.webhookUrl) {
          console.log(`  Webhook URL   : ${this.webhookUrl}/sms`);
        } else {
          console.log(
            `  Webhook URL   : (not set — signature validation skipped)`,
          );
        }
        console.log(
          `  Set Twilio SMS webhook → ${this.webhookUrl || 'http://<your-host>'}/sms\n`,
        );
        resolve();
      });
    });
  }

  private handleWebhook(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      // Validate Twilio signature when webhook URL is configured
      if (this.webhookUrl) {
        const signature = (req.headers['x-twilio-signature'] as string) || '';
        const fullUrl = `${this.webhookUrl}/sms`;
        const params = Object.fromEntries(new URLSearchParams(body));
        const isValid = twilio.validateRequest(
          this.authToken,
          signature,
          fullUrl,
          params,
        );
        if (!isValid) {
          logger.warn({ fullUrl }, 'SMS: invalid Twilio signature — rejected');
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
      }

      const params = new URLSearchParams(body);
      const from = params.get('From') || '';
      const msgBody = params.get('Body') || '';
      const msgSid = params.get('MessageSid') || `sms-${Date.now()}`;

      if (!from || !msgBody) {
        res.writeHead(400);
        res.end();
        return;
      }

      const chatJid = `${SMS_JID_PREFIX}${from}`;
      const timestamp = new Date().toISOString();

      // Store chat metadata so the number shows up in discovery
      this.opts.onChatMetadata(chatJid, timestamp, from, 'sms', false);

      const groups = this.opts.registeredGroups();
      if (!groups[chatJid]) {
        // If this is the owner's number and it hasn't been registered yet
        // (e.g., onRegisterGroup wasn't available at connect time), try again
        if (from === this.myNumber && this.opts.onRegisterGroup) {
          const folder = phoneToFolder(from);
          this.opts.onRegisterGroup(chatJid, {
            name: `SMS ${from}`,
            folder,
            trigger: `@${ASSISTANT_NAME}`,
            added_at: timestamp,
            requiresTrigger: false,
            isMain: true,
          });
          logger.info(
            { chatJid },
            'SMS: late-registered owner number on first message',
          );
        } else {
          logger.debug(
            { chatJid, from },
            'SMS from unregistered number — ignored',
          );
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          res.end('<Response></Response>');
          return;
        }
      }

      this.opts.onMessage(chatJid, {
        id: msgSid,
        chat_jid: chatJid,
        sender: from,
        sender_name: from,
        content: msgBody,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, from, length: msgBody.length }, 'SMS received');

      // Empty TwiML — reply is sent asynchronously via sendMessage
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<Response></Response>');
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const to = jid.slice(SMS_JID_PREFIX.length);
    try {
      const chunks = splitIntoChunks(text, SMS_CHUNK_SIZE);
      for (const chunk of chunks) {
        await this.client.messages.create({
          from: this.fromNumber,
          to,
          body: chunk,
        });
      }
      logger.info(
        { jid, chunks: chunks.length, totalLength: text.length },
        'SMS sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send SMS');
    }
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(SMS_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      logger.info('SMS webhook server stopped');
    }
  }
}

/**
 * Split text at word/newline boundaries, keeping chunks under maxLen.
 */
function splitIntoChunks(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxLen) {
    // Prefer splitting at a newline, then a space
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf(' ', maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Convert a phone number (+15551234567) into a safe folder name (sms-15551234567).
 */
function phoneToFolder(phone: string): string {
  return 'sms-' + phone.replace(/^\+/, '').replace(/\D/g, '');
}

registerChannel('sms', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'SMS_MY_NUMBER',
    'SMS_WEBHOOK_PORT',
    'SMS_WEBHOOK_URL',
  ]);

  const accountSid =
    process.env.TWILIO_ACCOUNT_SID || envVars.TWILIO_ACCOUNT_SID || '';
  const authToken =
    process.env.TWILIO_AUTH_TOKEN || envVars.TWILIO_AUTH_TOKEN || '';
  const fromNumber =
    process.env.TWILIO_FROM_NUMBER || envVars.TWILIO_FROM_NUMBER || '';
  const myNumber = process.env.SMS_MY_NUMBER || envVars.SMS_MY_NUMBER || '';
  const port = parseInt(
    process.env.SMS_WEBHOOK_PORT || envVars.SMS_WEBHOOK_PORT || '3002',
    10,
  );
  const webhookUrl =
    process.env.SMS_WEBHOOK_URL || envVars.SMS_WEBHOOK_URL || '';

  if (!accountSid || !authToken || !fromNumber) {
    logger.warn(
      'SMS: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_FROM_NUMBER not set — skipping',
    );
    return null;
  }

  return new SmsChannel(
    accountSid,
    authToken,
    fromNumber,
    myNumber,
    port,
    webhookUrl,
    opts,
  );
});
