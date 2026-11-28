// How sealed TSP messages reach the provider.
//
// The client seals and opens every message itself; a Carrier only moves bytes.
// The tests carry them in process to the reference provider. A live carrier
// moves them through the person's mediator to the VTA and back (still to do:
// see README, "What is still to do").

/** Carries one sealed request to the provider and resolves with the sealed reply. */
export type Carrier = (wire: Uint8Array) => Promise<Uint8Array>;
