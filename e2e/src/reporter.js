'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

/**
 * Collects per-check results grouped by test case and renders them to the
 * console, plus optional JSON and JUnit XML files (for CI).
 *
 * A "case" is one scenario+mode combination; it holds an array of assertion
 * results ({ name, ok, detail }).
 */
class Reporter {
  constructor() {
    this.cases = [];
  }

  /**
   * @param {object} c - { id, mode, durationMs, error?, checks: [{name,ok,detail}] }
   */
  addCase(c) {
    this.cases.push({ checks: [], ...c });
  }

  get passed() {
    return this.cases.filter((c) => this._casePassed(c)).length;
  }

  get failed() {
    return this.cases.length - this.passed;
  }

  _casePassed(c) {
    if (c.error) return false;
    return c.checks.length > 0 && c.checks.every((chk) => chk.ok);
  }

  printConsole() {
    console.log('');
    console.log(chalk.bold('Verdikta E2E results'));
    console.log('─'.repeat(60));
    for (const c of this.cases) {
      const ok = this._casePassed(c);
      const head = `${ok ? chalk.green('PASS') : chalk.red('FAIL')}  ${c.id} [${c.mode}]  ${c.durationMs}ms`;
      console.log(head);
      if (c.error) console.log(`      ${chalk.red('error:')} ${c.error}`);
      for (const chk of c.checks) {
        const mark = chk.ok ? chalk.green('✓') : chalk.red('✗');
        const line = `      ${mark} ${chk.name}${chk.detail ? chalk.gray(`  (${chk.detail})`) : ''}`;
        if (chk.ok) console.log(line);
        else console.log(chalk.red(line));
      }
    }
    console.log('─'.repeat(60));
    const summary = `${this.passed} passed, ${this.failed} failed, ${this.cases.length} total`;
    console.log(this.failed === 0 ? chalk.green.bold(summary) : chalk.red.bold(summary));
    console.log('');
  }

  writeJson(file) {
    const payload = {
      timestamp: new Date().toISOString(),
      summary: { passed: this.passed, failed: this.failed, total: this.cases.length },
      cases: this.cases.map((c) => ({ ...c, passed: this._casePassed(c) })),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  }

  writeJUnit(file) {
    const esc = (s) => String(s).replace(/[<>&"]/g, (ch) => (
      { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]
    ));
    const testcases = this.cases.map((c) => {
      const name = `${c.id} [${c.mode}]`;
      const time = ((c.durationMs || 0) / 1000).toFixed(3);
      if (this._casePassed(c)) {
        return `    <testcase name="${esc(name)}" time="${time}"/>`;
      }
      const failedChecks = c.checks.filter((chk) => !chk.ok)
        .map((chk) => `${chk.name} (${chk.detail})`).join('; ');
      const msg = c.error ? c.error : `failed checks: ${failedChecks}`;
      return `    <testcase name="${esc(name)}" time="${time}">\n` +
        `      <failure message="${esc(msg)}"/>\n` +
        `    </testcase>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<testsuite name="verdikta-e2e" tests="${this.cases.length}" ` +
      `failures="${this.failed}" time="${(this.cases.reduce((a, c) => a + (c.durationMs || 0), 0) / 1000).toFixed(3)}">\n` +
      `${testcases}\n</testsuite>\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, xml);
  }
}

module.exports = Reporter;
