// How sealed TSP messages reach the provider.
//
// The client seals and opens every message itself; a Carrier only moves bytes.
// The tests carry them in process to the reference provider. `MediatorCarrier`
// (mediator.ts) carries them through the agent's mediator to the VTA and back.

/** What the client tells a carrier about the request it is carrying, so the carrier can match the reply. */
export interface CarrierContext {
  /** The request document's `id`. */
  id: string;
  /** The request's `threadId`: the provider's reply carries the same one. */
  threadId: string;
}

/** Carries one sealed request to the provider and resolves with the sealed reply. */
export type Carrier = (wire: Uint8Array, context?: CarrierContext) => Promise<Uint8Array>;
