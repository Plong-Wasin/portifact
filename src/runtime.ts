// Shared shutdown state so health checks and the server cooperate: once
// draining begins, /health/ready reports unready while /health/live keeps
// answering so an orchestrator can tell a live-but-draining process from a
// dead one. Kept dependency-free; modules import the same singleton.
export interface ShutdownState {
  draining: boolean;
}

export const shutdown: ShutdownState = { draining: false };

export function beginDrain() {
  shutdown.draining = true;
}
