// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Vault} from "../src/Vault.sol";
import {Base} from "./Vm.sol";

contract VaultTest is Base {
    function test_deposit_credits_the_amount() public {
        Vault v = new Vault();
        v.deposit(5);
        vm.assertEq(v.balanceOf(address(this)), 5);
    }

    function test_withdraw_debits_the_amount() public {
        Vault v = new Vault();
        v.deposit(5);
        v.withdraw(2);
        vm.assertEq(v.balanceOf(address(this)), 3);
    }
}
