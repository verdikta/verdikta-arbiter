// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// NOTE: Intentionally vulnerable contract used as canonical E2E evidence.
// It contains a classic reentrancy bug (external call before state update),
// so a competent reviewer should return the "Vulnerabilities" outcome.
contract VulnerableBank {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    // Reentrancy: sends ETH via a low-level call BEFORE zeroing the balance,
    // allowing a malicious receiver to re-enter withdraw() and drain funds.
    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "nothing to withdraw");

        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");

        balances[msg.sender] = 0; // state updated too late
    }

    function balanceOf(address who) external view returns (uint256) {
        return balances[who];
    }
}
