'use strict';

/**
 * The PoCs of A3b's named fixtures, time-dependent-poc-two-hosts,
 * randomness-dependent-poc-two-hosts and flaky-poc-two-schedules: the same claims in
 * report.docker.test.js here, and on the canaries' real hosts through e2e's L4 claim set
 * (e2e/src/l2/claim/fixtures.js, node A6c).
 *
 * VM is the Vm shim with the cheatcodes they read. CANARY_IMAGE_OPTIONS are buildFixture's
 * options for the image they all run on: their foundry.toml needs ffi and ./state, and that
 * image is what the L2 claim suite builds and what G2 pushes for the canaries. Its vault is VAULT_REPO's, which
 * documents deposit (forgeFixture.js, DEPOSIT_RULE): the jurors read what deposit must do in the source the
 * finding names, so these claims test how the runner handles the PoC, not what the vault should do (A15).
 */

const { VAULT_REPO, VM_SOL, pocFile } = require('./forgeFixture');

const VM = VM_SOL.replace('    function assume(bool c) external pure;', [
  '    function assume(bool c) external pure;',
  '    function unixTime() external view returns (uint256);',
  '    function randomUint() external returns (uint256);',
  '    function toString(uint256 v) external pure returns (string memory);'
].join('\n'));

/** CPU work inside the test, so that the CPU schedule shows in forge's own time and not only in the runner's execs. */
const BURN = '    function burn() internal pure { uint256 x; for (uint256 i = 0; i < 1000000; i++) { x += i; } require(x > 0, "burn"); }';

const TIME_POC = pocFile('ClockTest', [
  BURN,
  '    function test_reads_the_clock() public { burn(); require(false, vm.toString(vm.unixTime())); }',
  '    function test_deposit_credits_exactly() public { Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }'
]);

const RANDOM_POC = pocFile('RandomTest', [
  BURN,
  '    function sh(string memory c) internal returns (string memory) { string[] memory a = new string[](3); a[0] = "/bin/sh"; a[1] = "-c"; a[2] = c; return string(vm.ffi(a)); }',
  '    function test_unseeded_random() public { burn(); require(false, sh("od -An -N8 -tx8 /dev/urandom")); }',
  '    function test_run_directory() public { require(false, sh("mktemp -d")); }',
  '    function test_seeded_random() public { require(false, vm.toString(vm.randomUint())); }'
]);

/** Fails on runs 1 and 3 or on run 2, by the clock's parity at run 1 (state/ keeps the run count): always mixed, and the phase follows the host. */
const FLAKY_POC = pocFile('FlakyTest', [
  BURN,
  '    function test_alternates() public {',
  '        burn();',
  '        uint256 run = 0; uint256 phase = 0;',
  '        if (vm.isFile("./state/run1")) { run = 1; phase = vm.isFile("./state/phase1") ? 1 : 0; }',
  '        if (vm.isFile("./state/run2")) run = 2;',
  '        if (run == 0) { phase = vm.unixTime() % 2000 < 1000 ? 0 : 1; if (phase == 1) vm.writeFile("./state/phase1", "1"); vm.writeFile("./state/run1", "1"); }',
  '        if (run == 1) vm.writeFile("./state/run2", "1");',
  '        require((run + phase) % 2 == 1, "this run fails");',
  '    }'
]);

const FFI_TOML = 'ffi = true';
const STATE_TOML = 'fs_permissions = [{ access = "read-write", path = "./state" }]';

const CANARY_IMAGE_OPTIONS = Object.freeze({
  files: Object.freeze({ ...VAULT_REPO, 'test/Vm.sol': VM }),
  toml: `${FFI_TOML}\n${STATE_TOML}`
});

module.exports = { VM, BURN, TIME_POC, RANDOM_POC, FLAKY_POC, FFI_TOML, STATE_TOML, CANARY_IMAGE_OPTIONS };
