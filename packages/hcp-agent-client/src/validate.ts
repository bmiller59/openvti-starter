// Payload validation with a full JSON Schema 2020-12 engine (ajv). The hcp/*
// schemas rely on `pattern`, `format` and `uniqueItems`, so a structural
// stand-in is not enough. Each generated module embeds its schema with its
// cross-file `$ref`s inlined, so no resolver is needed.

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { PayloadValidator, TrustTaskDocument } from "@openvtc/trust-tasks/runtime";
import * as discovery from "@openvtc/trust-tasks/trust-task-discovery/0.4/payload";
import * as error from "@openvtc/trust-tasks/trust-task-error/0.6/payload";
import * as nextStep from "@openvtc/trust-tasks/trust-task-next-step/0.1/payload";

import { HcpEntriesQuery_v0_1, HcpGrantsRequest_v0_1, HcpGrantsRevoked_v0_1 } from "./trust-tasks/index.js";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;
const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
const compiled = new WeakMap<object, ReturnType<typeof ajv.compile>>();

function check(schema: object, value: unknown): string[] {
  let validate = compiled.get(schema);
  if (validate === undefined) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  return validate(value) ? [] : (validate.errors ?? []).map((e) => `payload${e.instancePath} ${e.message}`);
}

/** The validator the inbound SPEC §7.2 pipeline runs (item 2). */
export const schemaValidator: PayloadValidator = {
  validate(schema, payload) {
    const errors = check(schema as object, payload);
    return { ok: errors.length === 0, errors };
  },
};

/** The schema each reply the client may receive must satisfy, by its `type`. */
const REPLY_SCHEMAS: Record<string, object> = {
  [discovery.RESPONSE_TYPE_URI]: discovery.RESPONSE_PAYLOAD_SCHEMA,
  [nextStep.TYPE_URI]: nextStep.PAYLOAD_SCHEMA,
  [error.TYPE_URI]: error.PAYLOAD_SCHEMA,
  [HcpGrantsRequest_v0_1.RESPONSE_TYPE_URI]: HcpGrantsRequest_v0_1.RESPONSE_PAYLOAD_SCHEMA,
  [HcpEntriesQuery_v0_1.RESPONSE_TYPE_URI]: HcpEntriesQuery_v0_1.RESPONSE_PAYLOAD_SCHEMA,
  [HcpGrantsRevoked_v0_1.RESPONSE_TYPE_URI]: HcpGrantsRevoked_v0_1.RESPONSE_PAYLOAD_SCHEMA,
};

/** Throws unless `reply`'s payload validates against its type's schema. */
export function validateReply(reply: TrustTaskDocument<unknown>): void {
  const schema = REPLY_SCHEMAS[reply.type];
  if (schema === undefined) throw new Error(`unexpected reply type ${reply.type}`);
  const errors = check(schema, reply.payload);
  if (errors.length > 0) throw new Error(`reply ${reply.type} fails its schema: ${errors.join("; ")}`);
}

/** How long the client waits before it resubmits when a next step's hint is absent or invalid. */
export const DEFAULT_RETRY_AFTER = 5;

/**
 * The seconds to wait before resubmitting a held grant request, read from the
 * next step's `expects[0].hint`. The hint must satisfy hcp/grants/request's
 * `$defs.NextStepHint` (an object whose only member, `retryAfter`, is an
 * integer from 1 to 3600); one that does not is ignored as if absent, and the
 * client waits {@link DEFAULT_RETRY_AFTER} (hcp/grants/request "Holding" rule 5).
 */
export function retryAfterOf(hint: unknown): number {
  const defs = (HcpGrantsRequest_v0_1.PAYLOAD_SCHEMA as { $defs?: Record<string, object> }).$defs;
  const schema = defs?.["NextStepHint"];
  if (schema === undefined) throw new Error("hcp/grants/request's schema has no NextStepHint");
  if (hint === undefined || check(schema, hint).length > 0) return DEFAULT_RETRY_AFTER;
  return (hint as { retryAfter: number }).retryAfter;
}
