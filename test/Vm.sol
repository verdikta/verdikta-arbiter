// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
interface Vm {
    function assertEq(uint256 a, uint256 b) external pure;
    function assertTrue(bool c, string calldata m) external pure;
    function skip(bool s) external;
    function ffi(string[] calldata c) external returns (bytes memory);
    function getCode(string calldata a) external view returns (bytes memory);
    function isFile(string calldata p) external returns (bool);
    function writeFile(string calldata p, string calldata d) external;
    function envString(string calldata k) external view returns (string memory);
    function assume(bool c) external pure;
    function unixTime() external view returns (uint256);
    function randomUint() external returns (uint256);
    function toString(uint256 v) external pure returns (string memory);
}
library console {
    address constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;
    function log(string memory s) internal view { (bool ok,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string)", s)); ok; }
}
abstract contract Base {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}
