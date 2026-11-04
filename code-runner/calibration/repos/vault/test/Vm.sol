// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// The cheatcodes these fixtures use, so that the repository needs no forge-std checkout.
interface Vm {
    function assertEq(uint256 a, uint256 b) external pure;
    function assertTrue(bool condition, string calldata message) external pure;
    function store(address target, bytes32 slot, bytes32 value) external;
    function etch(address target, bytes calldata code) external;
    function mockCall(address target, bytes calldata data, bytes calldata answer) external;
    function ffi(string[] calldata command) external returns (bytes memory);
    function isFile(string calldata path) external returns (bool);
    function writeFile(string calldata path, string calldata data) external;
    function chainId(uint256 id) external;
}

abstract contract Base {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}
