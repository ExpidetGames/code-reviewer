// POST /api/runners/v1/claim: the runner asks for its next job (200 with the job, 204 for none).
// Public for the session guard: the runner authenticates with its own token. All logic is in
// src/runner-api/; see its README.
import { getRunnerApi } from "../../../../../runner-api/shared.ts";

export async function POST(request: Request): Promise<Response> {
  return getRunnerApi().claim(request);
}
