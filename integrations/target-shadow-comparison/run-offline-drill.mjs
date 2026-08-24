import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import { openDatabase } from '../../apps/backend/dist/database.js';
import { compileTargetShadowPlan } from '../../apps/backend/dist/target-shadow-plan.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = process.argv[2] ? resolve(process.argv[2]) : join(here, 'fixtures/nonempty-target-scenarios.json');
const outputPath = process.argv[3] ? resolve(process.argv[3]) : join(here, 'offline-drill-report.json');
const legacyRoot = process.env.LEGACY_GATE_CROSSEX_ROOT;
const python = process.env.DRILL_PYTHON ?? 'python';
if (!legacyRoot) throw new Error('LEGACY_GATE_CROSSEX_ROOT is required');
const childEnvironment = Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','HOME','LANG'].flatMap((key)=>process.env[key]===undefined?[]:[[key,process.env[key]]]));
childEnvironment.LEGACY_GATE_CROSSEX_ROOT = resolve(legacyRoot);
globalThis.fetch = async () => { throw new Error('offline drill network access prohibited'); };

function aggregate(actions) {
  const result = new Map();
  for (const action of actions) {
    const key = `${action.kind}|${action.symbol}|${action.venue}|${action.side}`;
    result.set(key, (result.get(key) ?? new Decimal(0)).add(action.quoteQuantity));
  }
  return Object.fromEntries([...result.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value.toFixed()]));
}

function shape(actions) { return actions.map((action) => `${action.kind}|${action.symbol}|${action.venue}|${action.side}|${new Decimal(action.quoteQuantity).toFixed()}`).sort(); }
function projectClips(actions,limit='1000'){return actions.flatMap(action=>{let remaining=new Decimal(action.quoteQuantity);const cap=new Decimal(limit),count=remaining.div(cap).ceil().toNumber();return Array.from({length:count},(_,index)=>{const amount=Decimal.min(remaining,cap);remaining=remaining.sub(amount);return{...action,quoteQuantity:amount.toFixed(),clipIndex:String(index+1),clipCount:String(count)}})})}
function compactKinds(actions) { return actions.map((action) => action.kind).filter((kind, index, all) => index === 0 || kind !== all[index - 1]); }
function validShadowPhases(actions) { const hasReduction=actions.some((action)=>action.kind!=='OPEN');return actions.every((action)=>action.kind==='OPEN'?(hasReduction?action.phase===2&&action.dependsOnPhase===1:action.phase===1&&action.dependsOnPhase===null):action.phase===1&&action.dependsOnPhase===null); }

function targetState(scenario, index) {
  return {
    meta: { contract: 'gate-crossex-target-state', contract_version: 1, state_fingerprint: `sha256:${String(index + 1).padStart(64, '0')}` },
    positions: [{ symbol: 'BTCUSDT', target_side: scenario.targetSide, target_quote_qty: scenario.targetQuoteQty, route: { mode: 'AUTO', allowed_exchanges: ['GATE', 'BINANCE'], prefer_exchange: 'GATE', split_allowed: false, max_venue_count: 2, max_slippage_bps: 40, min_depth_notional: 500 } }],
  };
}

const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (fixture.contract !== 'target-shadow-offline-drill/v1') throw new Error('unsupported drill fixture contract');
const temporary = mkdtempSync(join(tmpdir(), 'target-shadow-drill-'));
const results = [];
try {
  for (const [index, scenario] of fixture.scenarios.entries()) {
    const database = openDatabase(join(temporary, `${scenario.id}.sqlite`), resolve(here, '../../migrations'));
    for (const [positionIndex, position] of scenario.positions.entries()) {
      const signedQuantity = Number(position.notional) / Number(fixture.markPrice) * (position.side === 'BUY' ? 1 : -1);
      database.prepare(`INSERT INTO live_positions(position_id,symbol,venue,quantity,entry_price,mark_price,realized_pnl,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(`${scenario.id}-${positionIndex}`, position.symbol, position.venue, String(signedQuantity), fixture.markPrice, fixture.markPrice, '0', '2026-08-24T00:00:00.000Z');
    }
    const plan = compileTargetShadowPlan(database, targetState(scenario, index), 'offline-drill', 'offline-drill', new Date('2026-08-24T00:00:00Z'));
    const legacy = JSON.parse(execFileSync(python, [join(here, 'legacy-router-drill.py')], { encoding: 'utf8', env: childEnvironment, input: JSON.stringify({ scenario, markPrice: fixture.markPrice, venueSnapshot: fixture.venueSnapshot }), timeout: 30_000 }));
    const projected=projectClips(legacy.actions),shadowAggregate=aggregate(plan.actions),legacyAggregate=aggregate(legacy.actions);
    const expectedKinds = scenario.expectedKinds.join(','), actualKinds = plan.actions.map((action) => action.kind).join(','), exposureSemanticStatus=JSON.stringify(shadowAggregate)===JSON.stringify(legacyAggregate)?'MATCH':'DIFFERENT', orderingStatus=actualKinds===expectedKinds&&JSON.stringify(compactKinds(plan.actions))===JSON.stringify(compactKinds(legacy.actions))?'MATCH':'DIFFERENT', shadowPhaseStatus=validShadowPhases(plan.actions)?'MATCH':'DIFFERENT', rawExecutionShapeStatus=JSON.stringify(shape(plan.actions))===JSON.stringify(shape(legacy.actions))?'MATCH':'DIFFERENT',projectedExecutionShapeStatus=JSON.stringify(shape(plan.actions))===JSON.stringify(shape(projected))?'MATCH':'DIFFERENT';
    results.push({ id: scenario.id, status:[exposureSemanticStatus,orderingStatus,shadowPhaseStatus,projectedExecutionShapeStatus].every((value)=>value==='MATCH')?'MATCH':'DIFFERENT', exposureSemanticStatus,orderingStatus,shadowPhaseStatus,rawExecutionShapeStatus,projectedExecutionShapeStatus,legacyPhaseEvidence:'UNAVAILABLE_ROUTER_SEQUENCE_ONLY',projectedClipNotional:'1000',expectedKinds,shadowKinds:actualKinds,shadowActions:plan.actions,legacyActions:legacy.actions,legacyProjectedActions:projected,shadowAggregate,legacyAggregate,shadowShape:shape(plan.actions),legacyShape:shape(legacy.actions),legacyProjectedShape:shape(projected),clipCountDifference:plan.actions.length-legacy.actions.length });
    database.close();
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
const report = { contract: 'target-shadow-offline-drill-report/v1', generatedAt: new Date().toISOString(), productionEvidence: false, counts: { total: results.length, match: results.filter((item) => item.status === 'MATCH').length, different: results.filter((item) => item.status === 'DIFFERENT').length }, results };
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, counts: report.counts }));
if (report.counts.different > 0) process.exitCode = 2;
