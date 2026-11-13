// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {ArbiterOperatorBase} from "./base/ArbiterOperatorBase.sol";
import {ConsumerStandIn, ReputationKeeperStandIn} from "./base/StandIns.sol";
import {ArbiterOperator, IArbiterOperator} from "../../contracts/ArbiterOperator.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Ownership: two steps, owner only.
contract OwnershipTest is ArbiterOperatorBase {
    function test_deployerIsOwner() public {
        assertEq(operator.owner(), owner);
        assertEq(operator.getChainlinkToken(), address(link));
    }

    function test_transferOwnership_takesEffectOnAccept() public {
        address next = makeAddr("next");
        vm.expectEmit(true, true, false, false, address(operator));
        emit OwnershipTransferRequested(owner, next);
        vm.prank(owner);
        operator.transferOwnership(next);
        assertEq(operator.owner(), owner, "ownership moved before it was accepted");

        vm.expectEmit(true, true, false, false, address(operator));
        emit OwnershipTransferred(owner, next);
        vm.prank(next);
        operator.acceptOwnership();
        assertEq(operator.owner(), next);
    }

    function test_transferOwnership_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("Only callable by owner"));
        operator.transferOwnership(stranger);
    }

    function test_acceptOwnership_onlyProposedOwner() public {
        vm.prank(owner);
        operator.transferOwnership(makeAddr("next"));
        vm.prank(stranger);
        vm.expectRevert(bytes("Must be proposed owner"));
        operator.acceptOwnership();
    }

    function test_withdraw_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("Only callable by owner"));
        operator.withdraw(stranger, 0);
    }
}

/// @notice Authorized senders: the keys that may fulfill. The owner or an authorized sender sets them.
contract AuthorizedSendersTest is ArbiterOperatorBase {
    function test_nodeIsTheOnlyAuthorizedSender() public {
        assertTrue(operator.isAuthorizedSender(node));
        assertFalse(operator.isAuthorizedSender(owner), "the owner is not a sender unless listed");
        address[] memory senders = operator.getAuthorizedSenders();
        assertEq(senders.length, 1);
        assertEq(senders[0], node);
    }

    function test_setAuthorizedSenders_replacesTheList() public {
        address other = makeAddr("other node");
        vm.expectEmit(false, false, false, true, address(operator));
        emit AuthorizedSendersChanged(_addresses(other), owner);
        vm.prank(owner);
        operator.setAuthorizedSenders(_addresses(other));
        assertTrue(operator.isAuthorizedSender(other));
        assertFalse(operator.isAuthorizedSender(node), "a sender left off the new list is still authorized");
    }

    function test_setAuthorizedSenders_byAnAuthorizedSender() public {
        address other = makeAddr("other node");
        vm.prank(node);
        operator.setAuthorizedSenders(_addresses(node, other));
        assertTrue(operator.isAuthorizedSender(other));
    }

    function test_setAuthorizedSenders_refusesAStranger() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("Cannot set authorized senders"));
        operator.setAuthorizedSenders(_addresses(stranger));
    }

    function test_setAuthorizedSenders_refusesAnEmptyList() public {
        vm.prank(owner);
        vm.expectRevert(bytes("Must have at least 1 sender"));
        operator.setAuthorizedSenders(new address[](0));
    }

    function test_setAuthorizedSenders_refusesDuplicates() public {
        vm.prank(owner);
        vm.expectRevert(bytes("Must not have duplicate senders"));
        operator.setAuthorizedSenders(_addresses(node, node));
    }
}

/// @notice The reputation keeper allow-list and the ERC-165 marker.
contract ReputationKeeperTest is ArbiterOperatorBase {
    function test_keeperIsListed() public {
        assertTrue(operator.isReputationKeeper(address(keeper)));
        assertFalse(operator.isReputationKeeperListEmpty());
    }

    function test_addReputationKeeper_listsAndEmits() public {
        ReputationKeeperStandIn second = new ReputationKeeperStandIn();
        vm.expectEmit(true, false, false, false, address(operator));
        emit ReputationKeeperAdded(address(second));
        vm.prank(owner);
        operator.addReputationKeeper(address(second));
        assertTrue(operator.isReputationKeeper(address(second)));
    }

    function test_addReputationKeeper_onlyOwner() public {
        ReputationKeeperStandIn second = new ReputationKeeperStandIn();
        vm.prank(stranger);
        vm.expectRevert(bytes("Only callable by owner"));
        operator.addReputationKeeper(address(second));
    }

    function test_addReputationKeeper_refusesAnAccount() public {
        vm.prank(owner);
        vm.expectRevert(bytes("RK: not contract"));
        operator.addReputationKeeper(stranger);
    }

    function test_addReputationKeeper_refusesADuplicate() public {
        vm.prank(owner);
        vm.expectRevert(bytes("RK: exists"));
        operator.addReputationKeeper(address(keeper));
    }

    function test_addReputationKeeper_refusesAContractWithoutTheInterface() public {
        // The LINK stand-in has no isContractApproved and no fallback, so the probe call fails.
        vm.prank(owner);
        vm.expectRevert(bytes("RK: interface"));
        operator.addReputationKeeper(address(link));
    }

    function test_removeReputationKeeper_emptiesTheList() public {
        vm.expectEmit(true, false, false, false, address(operator));
        emit ReputationKeeperRemoved(address(keeper));
        _removeKeeper();
        assertFalse(operator.isReputationKeeper(address(keeper)));
        assertTrue(operator.isReputationKeeperListEmpty());
    }

    function test_removeReputationKeeper_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("Only callable by owner"));
        operator.removeReputationKeeper(address(keeper));
    }

    function test_removeReputationKeeper_refusesAnUnknownKeeper() public {
        vm.prank(owner);
        vm.expectRevert(bytes("RK: unknown"));
        operator.removeReputationKeeper(stranger);
    }

    function test_supportsInterface() public {
        bytes4 id = type(IArbiterOperator).interfaceId;
        assertEq(
            id,
            IArbiterOperator.fulfillOracleRequestV.selector ^ IArbiterOperator.isReputationKeeper.selector
                ^ IArbiterOperator.isReputationKeeperListEmpty.selector
        );
        assertTrue(operator.supportsInterface(id));
        assertTrue(operator.supportsInterface(type(IERC165).interfaceId));
        assertFalse(operator.supportsInterface(0xffffffff));
    }
}

/// @notice A request and its fulfillment through fulfillOracleRequestV.
contract FulfillmentTest is ArbiterOperatorBase {
    function test_request_emitsOracleRequestAndEscrowsThePayment() public {
        bytes32 id = keccak256(abi.encodePacked(address(consumer), nextNonce));
        uint256 expiration = block.timestamp + operator.EXPIRYTIME();
        vm.expectEmit(true, false, false, true, address(operator));
        emit OracleRequest(
            SPEC_ID, address(consumer), id, PAYMENT, address(consumer), ConsumerStandIn.fulfill.selector, expiration, 2, ""
        );
        _request();
        assertEq(link.balanceOf(address(operator)), PAYMENT);
        assertEq(operator.withdrawable(), 0, "an unfulfilled request's payment is withdrawable");
    }

    function test_fulfillOracleRequestV_deliversTheResponse() public {
        Request memory r = _request();
        uint256[] memory scores = _scores(700_000, 300_000);

        vm.expectEmit(true, false, false, false, address(operator));
        emit OracleResponse(r.id);
        assertTrue(_fulfill(r, _response(r, scores, "bafkreijustification")));

        assertEq(consumer.fulfillments(), 1);
        assertEq(consumer.lastCaller(), address(operator));
        assertEq(consumer.lastRequestId(), r.id);
        assertEq(consumer.lastScores(), scores);
        assertEq(consumer.lastCid(), "bafkreijustification");
        assertEq(operator.withdrawable(), PAYMENT, "the fulfilled request's payment is not withdrawable");
    }

    function test_fulfillOracleRequestV_paysTheOwnerOut() public {
        Request memory r = _request();
        _fulfill(r, _response(r));
        vm.prank(owner);
        operator.withdraw(owner, PAYMENT);
        assertEq(link.balanceOf(owner), PAYMENT);
    }

    function test_fulfillOracleRequestV_isFinal() public {
        Request memory r = _request();
        _fulfill(r, _response(r));
        vm.prank(node);
        vm.expectRevert(bytes("Must have a valid requestId"));
        operator.fulfillOracleRequestV(r.id, r.payment, r.callback, r.callbackFunctionId, r.expiration, _response(r));
    }

    function test_fulfillOracleRequestV_aRevertingCallbackStillSettles() public {
        Request memory r = _request();
        consumer.setRefuse(true);
        vm.expectEmit(true, false, false, false, address(operator));
        emit OracleCallbackResult(r.id, false, "", 0);
        assertFalse(_fulfill(r, _response(r)), "the callback reverted but fulfillment reported success");
        assertEq(consumer.fulfillments(), 0);
        assertEq(operator.withdrawable(), PAYMENT, "the node is not paid when the consumer's callback reverts");
    }

    function test_fulfillOracleRequestV_withAnEmptyAllowListAnyRequesterPasses() public {
        _removeKeeper();
        ConsumerStandIn unlisted = new ConsumerStandIn(link);
        link.mint(address(unlisted), PAYMENT);
        Request memory r = _request(unlisted, PAYMENT);
        assertTrue(_fulfill(r, _response(r)));
        assertEq(unlisted.fulfillments(), 1);
    }

    function test_fulfillOracleRequestV_anyListedKeeperMayApprove() public {
        ReputationKeeperStandIn second = new ReputationKeeperStandIn();
        vm.prank(owner);
        operator.addReputationKeeper(address(second));
        keeper.setApproved(address(consumer), false);
        second.setApproved(address(consumer), true);
        Request memory r = _request();
        assertTrue(_fulfill(r, _response(r)));
    }
}

/// @notice Who and what fulfillOracleRequestV refuses.
contract FulfillmentAccessTest is ArbiterOperatorBase {
    function test_refusesASenderThatIsNotAuthorized() public {
        Request memory r = _request();
        vm.prank(stranger);
        vm.expectRevert(bytes("Not authorized sender"));
        operator.fulfillOracleRequestV(r.id, r.payment, r.callback, r.callbackFunctionId, r.expiration, _response(r));
    }

    function test_refusesTheOwnerUnlessAuthorized() public {
        Request memory r = _request();
        vm.prank(owner);
        vm.expectRevert(bytes("Not authorized sender"));
        operator.fulfillOracleRequestV(r.id, r.payment, r.callback, r.callbackFunctionId, r.expiration, _response(r));
    }

    function test_refusesARequesterNoKeeperApproves() public {
        Request memory r = _request();
        keeper.setApproved(address(consumer), false);
        vm.prank(node);
        vm.expectRevert(bytes("Operator: requester not approved"));
        operator.fulfillOracleRequestV(r.id, r.payment, r.callback, r.callbackFunctionId, r.expiration, _response(r));
    }

    function test_refusesAnUnknownRequestId() public {
        Request memory r = _request();
        r.id = keccak256("no such request");
        vm.prank(node);
        vm.expectRevert(bytes("Must have a valid requestId"));
        operator.fulfillOracleRequestV(r.id, r.payment, r.callback, r.callbackFunctionId, r.expiration, _response(r));
    }

    function test_refusesParamsThatDoNotMatchTheRequest() public {
        Request memory r = _request();
        vm.prank(node);
        vm.expectRevert(bytes("Params do not match request ID"));
        operator.fulfillOracleRequestV(r.id, r.payment + 1, r.callback, r.callbackFunctionId, r.expiration, _response(r));
    }

    function test_refusesAResponseForAnotherRequest() public {
        Request memory r = _request();
        Request memory other = _request();
        vm.prank(node);
        vm.expectRevert(bytes("First word must be requestId"));
        operator.fulfillOracleRequestV(r.id, r.payment, r.callback, r.callbackFunctionId, r.expiration, _response(other));
    }

    function test_refusesAResponseShorterThanOneWord() public {
        Request memory r = _request();
        vm.prank(node);
        vm.expectRevert(bytes("Response must be > 32 bytes"));
        operator.fulfillOracleRequestV(r.id, r.payment, r.callback, r.callbackFunctionId, r.expiration, hex"00");
    }

    function test_refusesTooLittleGasForTheConsumer() public {
        Request memory r = _request();
        bytes memory data = _response(r);
        vm.prank(node);
        vm.expectRevert(bytes("Operator: not enough gas for consumer"));
        operator.fulfillOracleRequestV{gas: MINIMUM_CONSUMER_GAS - 100_000}(
            r.id, r.payment, r.callback, r.callbackFunctionId, r.expiration, data
        );
    }

    function test_requestsComeOnlyThroughLink() public {
        vm.prank(address(consumer));
        vm.expectRevert(bytes("Must use LINK token"));
        operator.operatorRequest(
            address(consumer), PAYMENT, SPEC_ID, ConsumerStandIn.fulfill.selector, 1, 2, ""
        );
    }
}
