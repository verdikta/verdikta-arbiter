// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface Vm {
    function assertEq(uint256 a, uint256 b) external pure;
    function chainId(uint256 id) external;
}

abstract contract Base {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}
