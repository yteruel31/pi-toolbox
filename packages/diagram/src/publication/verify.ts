import { randomBytes } from "node:crypto";

export interface ChallengeHost {
  setChallenge(token: string): Promise<() => Promise<void> | void>;
}

export async function verifyExternalPublication(publicBaseUrl: string, host: ChallengeHost, fetcher: typeof fetch = fetch): Promise<void> {
  const token = randomBytes(24).toString("base64url");
  const clear = await host.setChallenge(token);
  try {
    const response = await fetcher(`${publicBaseUrl}/_challenge/${token}`, {
      headers: { accept: "text/plain" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`external challenge returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 256 || text !== token) throw new Error("external challenge response did not match");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Diagram external URL could not reach this Pi host: ${reason}`);
  } finally {
    await clear();
  }
}
