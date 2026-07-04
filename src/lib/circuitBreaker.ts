type CircuitState = "closed" | "open" | "half_open";

type CircuitOptions = {
  failureThreshold: number;
  openMs: number;
};

type Circuit = {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
};

const circuits = new Map<string, Circuit>();

function circuitFor(name: string): Circuit {
  const existing = circuits.get(name);
  if (existing) return existing;
  const created: Circuit = { state: "closed", failures: 0, openedAt: null };
  circuits.set(name, created);
  return created;
}

export function getCircuitState(name: string): CircuitState {
  return circuitFor(name).state;
}

export function allowCircuitRequest(name: string, options: CircuitOptions): boolean {
  const circuit = circuitFor(name);
  if (circuit.state !== "open") return true;
  const openedAt = circuit.openedAt ?? 0;
  if (Date.now() - openedAt >= options.openMs) {
    circuit.state = "half_open";
    return true;
  }
  return false;
}

export function recordCircuitSuccess(name: string): void {
  const circuit = circuitFor(name);
  circuit.state = "closed";
  circuit.failures = 0;
  circuit.openedAt = null;
}

export function recordCircuitFailure(name: string, options: CircuitOptions): void {
  const circuit = circuitFor(name);
  circuit.failures += 1;
  if (circuit.failures >= options.failureThreshold) {
    circuit.state = "open";
    circuit.openedAt = Date.now();
  }
}

export async function withCircuitBreaker<T>(
  name: string,
  options: CircuitOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (!allowCircuitRequest(name, options)) {
    throw new Error(`Circuit breaker is open: ${name}`);
  }

  try {
    const result = await fn();
    recordCircuitSuccess(name);
    return result;
  } catch (err) {
    recordCircuitFailure(name, options);
    throw err;
  }
}
