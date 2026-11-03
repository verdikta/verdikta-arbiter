// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";

// The ordinary idioms of a Foundry test: no rule may raise a flag on any line of this file.
contract Idioms is Test {
    using stdStorage for StdStorage;

    Vault vault;
    IERC20 token;
    Pool pool;
    Registry registry;
    Vm constant handle = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant FEE = 30;
    uint256 stored;

    function setUp() public {
        vm.label(address(vault), "vault");
        vault = new Vault();
        deal(address(this), 1 ether);
        deal(address(token), address(this), 1e18);
        deal(address(token), address(this), 1e18, true);
        vm.deal(address(this), 1 ether);
        address alice = makeAddr("alice");
        (address bob, uint256 key) = makeAddrAndKey("bob");
        vm.addr(key);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, bytes32(0));
        vm.assume(alice != bob);
        bound(uint256(1), 0, 10);
        hoax(alice);
        hoax(alice, 1 ether);
        startHoax(alice);
        changePrank(bob);
        vm.stopPrank();
    }

    function test_clock_forward() public {
        vm.warp(100);
        vm.warp(block.timestamp + 1 days);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.warp(block.timestamp + 1);
        vm.warp(start + 7 days);
        skip(1 days);
        vm.roll(100);
        vm.roll(block.number + 1);
        vm.getBlockTimestamp();
        vm.getBlockNumber();
        assertEq(block.timestamp, 100);
    }

    function test_actors() public {
        vm.prank(address(1));
        vault.deposit(1);
        vm.prank(address(1), address(2));
        vm.startPrank(address(1));
        vault.deposit(1);
        vm.stopPrank();
    }

    function test_expectations() public {
        vm.expectRevert();
        vm.expectRevert(bytes("nope"));
        vm.expectEmit(true, true, true, true);
        vm.expectCall(address(vault), hex"00");
        vm.record();
        vm.accesses(address(vault));
        vm.load(address(vault), bytes32(0));
        vm.recordLogs();
        vm.getRecordedLogs();
        uint256 snap = vm.snapshotState();
        vm.revertToState(snap);
        vm.pauseGasMetering();
        vm.resumeGasMetering();
        console.log("a line");
        assertEq(uint256(1), 1);
        assertTrue(true);
    }

    function test_artifacts() public {
        deployCode("Vault.sol");
        deployCode("Vault.sol", hex"00");
        vm.getCode("Vault.sol");
        vm.getDeployedCode("Vault.sol");
        vm.toString(uint256(1));
        vm.parseJson("{}");
        vm.envOr("A", uint256(1));
    }

    function test_names_a_contract_may_have() public {
        vault.store(1);
        vault.store(1, 2);
        store(1, 2, 3);
        stored = 1;
        pool.fee();
        pool.fee(1);
        pool.chainId();
        token.transfer(address(1), 1);
        address(vault).call(hex"00");
        address(token).staticcall(hex"00");
        vault.warp;
        vault.exists("a");
        registry.isFile("a");
        vault.sleep(1);
        vault.roll(1);
        vault.setNonce(1);
        uint256 fee = FEE + block.chainid + block.timestamp - 1;
        // A comment may name vm.store, vm.etch and vm.mockCall in words; the rules read code.
        string memory words = "vm.store is a cheatcode";
        words;
        fee;
    }

    function store(uint256 a, uint256 b, uint256 c) internal {}
}
