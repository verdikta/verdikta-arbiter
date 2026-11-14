// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Every line marked `flag:` must raise exactly the rules it names, and no other line may raise any.
interface Cheat { function store(address a, bytes32 b, bytes32 c) external; }

// Wherever code can run.
function free() { vm.etch(address(1), hex"00"); } // flag: code-overwrite

library Lib {
    function l() internal { vm.etch(address(1), hex"00"); } // flag: code-overwrite
}

contract Positive {
    Vm constant other = Vm(HEVM_ADDRESS);

    constructor() { vm.etch(address(1), hex"00"); } // flag: code-overwrite
    receive() external payable { vm.etch(address(1), hex"00"); } // flag: code-overwrite
    fallback() external { vm.etch(address(1), hex"00"); } // flag: code-overwrite
    modifier m() { vm.etch(address(1), hex"00"); _; } // flag: code-overwrite

    function storage_() public {
        vm.store(address(1), bytes32(0), bytes32(0)); // flag: storage-overwrite
        vm.store({target: address(1), slot: bytes32(0), value: bytes32(0)}); // flag: storage-overwrite store-named-arguments
        vm
            .store(address(1), bytes32(0), bytes32(0)); // flag@-1: storage-overwrite
        vm.setArbitraryStorage(address(1)); // flag: storage-overwrite
        vm.copyStorage(address(1), address(2)); // flag: storage-overwrite
        vm.loadAllocs("allocs.json"); // flag: storage-overwrite
        stdstore.target(address(1)).sig("x()").checked_write(1); // flag: storage-overwrite
        stdstore.target(address(1)).sig("x()").checked_write_int(int256(1)); // flag: storage-overwrite
        function(address, bytes32, bytes32) external f = vm.store; // flag: storage-overwrite
        abi.encodeCall(vm.store, (address(1), bytes32(0), bytes32(0))); // flag: storage-overwrite
        target.call(abi.encodeWithSelector(Vm.store.selector, address(1), bytes32(0), bytes32(0))); // flag: storage-overwrite
        try vm.store(address(1), bytes32(0), bytes32(0)) {} catch {} // flag: storage-overwrite
        unchecked { vm.store(address(1), bytes32(0), bytes32(0)); } // flag: storage-overwrite
    }

    function aliases() public {
        Vm cheat = vm;
        cheat.store(address(1), bytes32(0), bytes32(0)); // flag: store-shaped-call
        (vm).store(address(1), bytes32(0), bytes32(0)); // flag: storage-overwrite
        Vm(HEVM_ADDRESS).store(address(1), bytes32(0), bytes32(0)); // flag: store-shaped-call
        Vm(address(uint160(uint256(keccak256("hevm cheat code"))))).store(address(1), bytes32(0), bytes32(0)); // flag: store-shaped-call
        Cheat(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D).store(address(1), bytes32(0), bytes32(0)); // flag: store-shaped-call cheatcode-address
        Cheat(address(1)).store({a: address(1), b: bytes32(0), c: bytes32(0)}); // flag: store-named-arguments
        registry.store(address(1), 2, 3); // flag: store-shaped-call
        target.call(abi.encodeWithSelector(Cheat.store.selector, address(1), bytes32(0), bytes32(0))); // flag: store-shaped-call
        abi.encodeCall(cheat.store, (address(1), bytes32(0), bytes32(0))); // flag: store-shaped-call
    }

    function code() public {
        vm.etch(address(1), hex"00"); // flag: code-overwrite
        other.etch(address(1), hex"00"); // flag: code-overwrite
        deployCodeTo("Foo.sol", address(1)); // flag: code-overwrite
        deployCodeTo("Foo.sol", hex"", address(1)); // flag: code-overwrite
        stdCheats.deployCodeTo("Foo.sol", address(1)); // flag: code-overwrite
        vm.attachDelegation(signed); // flag: code-overwrite
        vm.signAndAttachDelegation(address(1), 1); // flag: code-overwrite
        target.call(abi.encodeWithSelector(Vm.etch.selector, address(1), hex"00")); // flag: code-overwrite
    }

    function mocks() public {
        vm.mockCall(address(1), hex"00", hex"00"); // flag: call-mocked
        vm.mockCallRevert(address(1), hex"00", hex"00"); // flag: call-mocked
        vm.mockCalls(address(1), hex"00", new bytes[](0)); // flag: call-mocked
        vm.mockFunction(address(1), address(2), hex"00"); // flag: call-mocked
        other.mockCall(address(1), hex"00", hex"00"); // flag: call-mocked
    }

    function processes() public {
        vm.ffi(new string[](0)); // flag: process-started
        vm.tryFfi(new string[](0)); // flag: process-started
    }

    function raw() public {
        address(vm).call(hex"00"); // flag: cheatcode-raw-call
        address(vm).staticcall(hex"00"); // flag: cheatcode-raw-call
        address(vmSafe).call(hex"00"); // flag: cheatcode-raw-call
        VM_ADDRESS.call(hex"00"); // flag: cheatcode-raw-call
        HEVM_ADDRESS.call(hex"00"); // flag: cheatcode-raw-call
        target.call(abi.encodeWithSignature("store(address,bytes32,bytes32)", address(1), bytes32(0), bytes32(0))); // flag: cheatcode-signature
        target.call(abi.encodeWithSignature("etch(address,bytes)", address(1), hex"00")); // flag: cheatcode-signature
        target.call(abi.encodeWithSignature("ffi(string[])", new string[](0))); // flag: cheatcode-signature
        target.call(abi.encodeWithSelector(0x70ca10bb, address(1), bytes32(0), bytes32(0))); // flag: cheatcode-signature
        target.call(abi.encodeWithSelector(0xB4D6C782, address(1), hex"00")); // flag: cheatcode-signature
        address(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D).call(hex"00"); // flag: cheatcode-address
        assembly { let ok := call(gas(), 0x7109709ecfa91a80626ff3989d68f67f5b1dd12d, 0, 0, 0, 0, 0) } // flag: cheatcode-address
    }

    function network() public {
        vm.createFork("mainnet"); // flag: network-reach
        vm.createSelectFork("mainnet"); // flag: network-reach
        vm.selectFork(1); // flag: network-reach
        vm.rollFork(1); // flag: network-reach
        vm.rpc("eth_call", "[]"); // flag: network-reach
        vm.rpcUrl("mainnet"); // flag: network-reach
        vm.rpcUrls(); // flag: network-reach
        vm.rpcUrlStructs(); // flag: network-reach
        vm.eth_getLogs(1, 2, address(1), new bytes32[](0)); // flag: network-reach
        vm.transact(bytes32(0)); // flag: network-reach
    }

    function writes() public {
        vm.writeFile("a", "b"); // flag: filesystem-write
        vm.writeFileBinary("a", hex"00"); // flag: filesystem-write
        vm.writeLine("a", "b"); // flag: filesystem-write
        vm.writeJson("{}", "a"); // flag: filesystem-write
        vm.writeToml("", "a"); // flag: filesystem-write
        vm.copyFile("a", "b"); // flag: filesystem-write
        vm.removeFile("a"); // flag: filesystem-write
        vm.removeDir("a", true); // flag: filesystem-write
        vm.createDir("a", true); // flag: filesystem-write
        vm.dumpState("a"); // flag: filesystem-write
    }

    function reads() public {
        vm.readFile("/etc/passwd"); // flag: filesystem-read
        vm.readFileBinary("a"); // flag: filesystem-read
        vm.readLine("a"); // flag: filesystem-read
        vm.readDir("a"); // flag: filesystem-read
        vm.readLink("a"); // flag: filesystem-read
        vm.fsMetadata("a"); // flag: filesystem-read
        vm.exists("a"); // flag: filesystem-read
        vm.isFile("a"); // flag: filesystem-read
        vm.isDir("a"); // flag: filesystem-read
    }

    function clock() public {
        rewind(10); // flag: clock
        vm.warp(block.timestamp - 1 days); // flag: clock
        vm.warp(vm.getBlockTimestamp() - 1 days); // flag: clock
        vm.warp(0); // flag: clock
        vm.warp(type(uint256).max); // flag: clock
        vm.warp(type(uint64).max); // flag: clock
        vm.roll(block.number - 1); // flag: clock
        vm.roll(vm.getBlockNumber() - 1); // flag: clock
        vm.roll(0); // flag: clock
        vm.roll(type(uint256).max); // flag: clock
        vm.unixTime(); // flag: clock
        vm.sleep(1000); // flag: clock
        other.warp(block.timestamp - 1); // flag: clock
    }

    function blockEnv() public {
        vm.setBlockhash(1, bytes32(0)); // flag: block-environment
        vm.prevrandao(bytes32(0)); // flag: block-environment
        vm.difficulty(1); // flag: block-environment
        vm.chainId(1); // flag: block-environment
        vm.fee(1); // flag: block-environment
        vm.coinbase(address(1)); // flag: block-environment
        vm.txGasPrice(1); // flag: block-environment
        vm.blobBaseFee(1); // flag: block-environment
        vm.blobhashes(new bytes32[](0)); // flag: block-environment
        vm.setNonce(address(1), 1); // flag: block-environment
        vm.setNonceUnsafe(address(1), 1); // flag: block-environment
        vm.resetNonce(address(1)); // flag: block-environment
        vm.setEnv("A", "B"); // flag: block-environment
        vm.setEvmVersion("cancun"); // flag: block-environment
    }
}
