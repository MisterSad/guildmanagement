/**
 * src/workers/matchup.worker.ts
 *
 * Web Worker offloading heavy sorting, power penalty calculations,
 * and dangerosity score calculations from the main UI thread.
 */

export interface MatchupMemberInput {
  pseudo: string;
  guild?: string;
  overall_power: number;
}

export interface MatchupCalculationResult {
  members: Array<MatchupMemberInput & { tier: string; powerPenalty: number; adjustedPower: number }>;
  totalPower: number;
  averagePower: number;
  dangerosityScore: number;
}

export function computeMemberTier(power: number): string {
  if (power >= 100000000) return 'S';
  if (power >= 50000000) return 'A';
  if (power >= 25000000) return 'B';
  if (power >= 10000000) return 'C';
  return 'D';
}

export function calculateMatchupData(members: MatchupMemberInput[]): MatchupCalculationResult {
  let totalPower = 0;
  const processed = members.map((m) => {
    const power = Number(m.overall_power) || 0;
    totalPower += power;
    const tier = computeMemberTier(power);
    const powerPenalty = power > 75000000 ? 0.9 : 1.0;
    const adjustedPower = Math.round(power * powerPenalty);
    return {
      ...m,
      overall_power: power,
      tier,
      powerPenalty,
      adjustedPower
    };
  });

  processed.sort((a, b) => b.adjustedPower - a.adjustedPower);

  const averagePower = processed.length > 0 ? Math.round(totalPower / processed.length) : 0;
  const dangerosityScore = Math.round(totalPower / 1000000);

  return {
    members: processed,
    totalPower,
    averagePower,
    dangerosityScore
  };
}

export async function calculateMatchupAsync(members: MatchupMemberInput[]): Promise<MatchupCalculationResult> {
  return new Promise((resolve) => {
    try {
      if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
        const workerBlob = new Blob([
          `(${computeMemberTier.toString()});\n(${calculateMatchupData.toString()});\nself.onmessage = function(e) { if (e.data && e.data.action === 'calculateMatchup') { self.postMessage({ action: 'calculateMatchupResult', result: calculateMatchupData(e.data.payload || []) }); } };`
        ], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(workerBlob);
        const worker = new Worker(workerUrl);

        worker.onmessage = (e: MessageEvent) => {
          if (e.data?.action === 'calculateMatchupResult') {
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            resolve(e.data.result);
          }
        };

        worker.onerror = () => {
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          resolve(calculateMatchupData(members));
        };

        worker.postMessage({ action: 'calculateMatchup', payload: members });
        return;
      }
    } catch {
      // Fallback to synchronous calculation
    }
    resolve(calculateMatchupData(members));
  });
}

// Handle Web Worker message events if running in worker context
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.addEventListener('message', (e: MessageEvent) => {
    const { action, payload } = e.data || {};
    if (action === 'calculateMatchup') {
      const result = calculateMatchupData(payload || []);
      self.postMessage({ action: 'calculateMatchupResult', result });
    }
  });
}

