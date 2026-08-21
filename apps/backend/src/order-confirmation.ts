import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { buildOrderPreview, type OrderPreview } from './order-preview.js';
import type { ExecutionOrder, TradingRuntime } from './trading-runtime.js';

export const IdempotencyKeySchema = z.string().trim().min(16).max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

type PreviewStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';

interface OrderPreviewRow {
  id: string;
  request_hash: string;
  signature: string;
  canonical_order_json: string;
  created_at: string;
  expires_at: string;
  status: PreviewStatus;
  idempotency_key: string | null;
  planned_order_id: string | null;
  planned_client_order_id: string | null;
  execution_order_id: string | null;
  failure_code: string | null;
  consumed_at: string | null;
  updated_at: string;
}

export class OrderConfirmationError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = 'OrderConfirmationError';
  }
}

function signaturePayload(preview: Pick<OrderPreview, 'previewId' | 'requestHash' | 'createdAt' | 'expiresAt' | 'canonicalOrder'>): string {
  return JSON.stringify({
    previewId: preview.previewId,
    requestHash: preview.requestHash,
    createdAt: preview.createdAt,
    expiresAt: preview.expiresAt,
    canonicalOrder: preview.canonicalOrder,
  });
}

function sign(secret: Buffer, preview: Pick<OrderPreview, 'previewId' | 'requestHash' | 'createdAt' | 'expiresAt' | 'canonicalOrder'>): string {
  return createHmac('sha256', secret).update(signaturePayload(preview)).digest('hex');
}

function signatureMatches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(actual, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export class OrderConfirmationStore {
  constructor(
    private readonly database: Database.Database,
    private readonly signingSecret: Buffer = randomBytes(32),
  ) {}

  create(raw: unknown, now: Date = new Date()): OrderPreview {
    const preview = buildOrderPreview(raw, now);
    const signature = sign(this.signingSecret, preview);
    this.database.prepare(`INSERT INTO order_previews
      (id, request_hash, signature, canonical_order_json, created_at, expires_at, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`)
      .run(preview.previewId, preview.requestHash, signature, JSON.stringify(preview.canonicalOrder),
        preview.createdAt, preview.expiresAt, preview.createdAt);
    return preview;
  }

  async confirm(
    previewId: string,
    idempotencyKey: string,
    runtime: TradingRuntime,
    now: Date = new Date(),
  ): Promise<ExecutionOrder> {
    const canonicalKey = IdempotencyKeySchema.parse(idempotencyKey);
    const keyOwner = this.database.prepare(`SELECT id FROM order_previews WHERE idempotency_key = ? LIMIT 1`)
      .get(canonicalKey) as { id: string } | undefined;
    if (keyOwner && keyOwner.id !== previewId) {
      throw new OrderConfirmationError('idempotency_key_conflict', 409);
    }

    const row = this.database.prepare('SELECT * FROM order_previews WHERE id = ?')
      .get(previewId) as OrderPreviewRow | undefined;
    if (!row) throw new OrderConfirmationError('order_preview_not_found', 404);

    let canonicalOrder: OrderPreview['canonicalOrder'];
    try {
      canonicalOrder = JSON.parse(row.canonical_order_json) as OrderPreview['canonicalOrder'];
    } catch {
      throw new OrderConfirmationError('order_preview_tampered', 409);
    }
    const material = {
      previewId: row.id,
      requestHash: row.request_hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      canonicalOrder,
    };
    const expected = sign(this.signingSecret, material);
    const rebuilt = buildOrderPreview(canonicalOrder, new Date(row.created_at));
    if (!signatureMatches(expected, row.signature) || rebuilt.requestHash !== row.request_hash) {
      throw new OrderConfirmationError('order_preview_tampered', 409);
    }

    if (row.status === 'SUCCEEDED' && row.execution_order_id) return runtime.getOrder(row.execution_order_id);
    if (row.status === 'FAILED') {
      throw new OrderConfirmationError(row.failure_code ?? 'confirmation_failed', 409);
    }
    if (row.status === 'PROCESSING') {
      if (!row.planned_order_id) throw new OrderConfirmationError('confirmation_in_progress', 409);
      try {
        const recovered = runtime.getOrder(row.planned_order_id);
        this.database.prepare(`UPDATE order_previews SET status = 'SUCCEEDED', execution_order_id = ?,
          updated_at = ? WHERE id = ? AND status = 'PROCESSING'`)
          .run(recovered.id, now.toISOString(), previewId);
        return recovered;
      } catch {
        throw new OrderConfirmationError('confirmation_in_progress', 409);
      }
    }
    if (new Date(row.expires_at).getTime() <= now.getTime()) {
      throw new OrderConfirmationError('order_preview_expired', 410);
    }

    const plannedOrderId = randomUUID();
    const plannedClientOrderId = `gct-${previewId.replaceAll('-', '').slice(0, 20)}`;
    let claimed: Database.RunResult;
    try {
      claimed = this.database.prepare(`UPDATE order_previews SET status = 'PROCESSING', idempotency_key = ?,
        planned_order_id = ?, planned_client_order_id = ?, consumed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'PENDING' AND idempotency_key IS NULL`)
        .run(canonicalKey, plannedOrderId, plannedClientOrderId, now.toISOString(), now.toISOString(), previewId);
    } catch {
      const conflict = this.database.prepare('SELECT id FROM order_previews WHERE idempotency_key = ?')
        .get(canonicalKey) as { id: string } | undefined;
      if (conflict && conflict.id !== previewId) throw new OrderConfirmationError('idempotency_key_conflict', 409);
      throw new OrderConfirmationError('order_preview_already_consumed', 409);
    }
    if (claimed.changes !== 1) throw new OrderConfirmationError('order_preview_already_consumed', 409);

    try {
      const order = await runtime.createOrder(canonicalOrder, undefined, {
        orderId: plannedOrderId,
        clientOrderId: plannedClientOrderId,
      });
      this.database.prepare(`UPDATE order_previews SET status = 'SUCCEEDED', execution_order_id = ?,
        updated_at = ? WHERE id = ?`).run(order.id, new Date().toISOString(), previewId);
      return order;
    } catch (error) {
      try {
        const persisted = runtime.getOrder(plannedOrderId);
        this.database.prepare(`UPDATE order_previews SET status = 'SUCCEEDED', execution_order_id = ?,
          failure_code = ?, updated_at = ? WHERE id = ?`)
          .run(persisted.id, error instanceof Error ? error.message.slice(0, 120) : 'submit_outcome_unknown',
            new Date().toISOString(), previewId);
      } catch {
        const failureCode = error instanceof Error ? error.message.slice(0, 120) : 'confirmation_failed';
        this.database.prepare(`UPDATE order_previews SET status = 'FAILED', failure_code = ?, updated_at = ?
          WHERE id = ?`).run(failureCode, new Date().toISOString(), previewId);
      }
      throw error;
    }
  }
}
