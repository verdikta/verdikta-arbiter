#!/usr/bin/env node
'use strict';

/**
 * G2's read of p95 latency and σ of the valid mass, over the reports of many L4 runs:
 *
 *   node scripts/l4-metrics.js results/*.json
 *
 * Exit 0 only with enough samples and every limit met (src/l4/metrics.js); one run has too few.
 * Reads the `--report` files; the workflow uploads them as the `l4-report` artifact.
 */

const fs = require('fs');
const { summarize, gate } = require('../src/l4/metrics');

function main(files) {
  if (files.length === 0) throw new Error('name at least one L4 report: node scripts/l4-metrics.js results/*.json');
  const rounds = [];
  const disputes = [];
  // A report named twice, or copied, is one measurement: a round is its request.
  const once = (seen) => (item) => {
    if (!item.aggId) return true;
    if (seen.has(item.aggId)) return false;
    seen.add(item.aggId);
    return true;
  };
  const newRound = once(new Set());
  const newDispute = once(new Set());
  for (const file of files) {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`${file} is not a report: ${error.message}`);
    }
    if (!report || !Array.isArray(report.cases)) throw new Error(`${file} is not a report: it has no cases`);
    for (const c of report.cases) {
      if (!c.metrics) continue;
      rounds.push(...(c.metrics.rounds || []).filter(newRound));
      if (c.metrics.dispute && newDispute(c.metrics.dispute)) disputes.push(c.metrics.dispute);
    }
  }
  const result = gate(summarize(rounds, disputes));
  console.log(`${files.length} report(s), ${rounds.length} round(s)`);
  for (const line of result.lines) console.log(line);
  return result.ok ? 0 : 1;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  console.error(`l4-metrics: ${error.message}`);
  process.exit(1);
}
