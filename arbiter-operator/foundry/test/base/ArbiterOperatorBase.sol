// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {Test} from "forge-std/Test.sol";
import {ArbiterOperator} from "../../../contracts/ArbiterOperator.sol";
import {ConsumerStandIn, LinkTokenStandIn, ReputationKeeperStandIn} from "./StandIns.sol";

/// @title ArbiterOperatorBase
/// @notice The base for ArbiterOperator tests and proofs of concept. setUp() deploys:
///   - `link`: a LINK token stand-in (ERC-20 balances and ERC-677 transferAndCall);
///   - `operator`: ArbiterOperator, owned by `owner`, with `node` (a Chainlink node's key) as its one
///     authorized sender;
///   - `keeper`: a reputation keeper stand-in on the operator's allow-list (addReputationKeeper needs a
///     contract that answers isContractApproved);
///   - `consumer`: a requester the keeper approves, holding LINK.
/// An operator deployed by this repository starts with an empty allow-list, which lets any requester
/// through; `_removeKeeper()` gives that state.
///
/// A request is `_request()`: the consumer pays `PAYMENT` through LINK's transferAndCall, which calls the
/// operator's operatorRequest, as Chainlink clients do. `_fulfill()` answers it as the node does, through
/// fulfillOracleRequestV, with the job's response shape (`_response`: requestId, scores, justification CID).
abstract contract ArbiterOperatorBase is Test {
    uint256 internal constant PAYMENT = 0.1 ether;
    uint256 internal constant CONSUMER_LINK = 100 ether;
    bytes32 internal constant SPEC_ID = keccak256("verdikta-ai");
    /// The operator's MY_MINIMUM_CONSUMER_GAS_LIMIT: fulfillOracleRequestV refuses with less gas left.
    uint256 internal constant MINIMUM_CONSUMER_GAS = 400_000;

    address internal owner = makeAddr("owner");
    address internal node = makeAddr("node");
    address internal stranger = makeAddr("stranger");

    LinkTokenStandIn internal link;
    ArbiterOperator internal operator;
    ReputationKeeperStandIn internal keeper;
    ConsumerStandIn internal consumer;

    uint256 internal nextNonce = 1;

    /// What a fulfillment must repeat of its request (the operator keeps only their hash).
    struct Request {
        bytes32 id;
        uint256 payment;
        address callback;
        bytes4 callbackFunctionId;
        uint256 expiration;
    }

    // ArbiterOperator's and Operator's events, declared here for vm.expectEmit (solc 0.8.19 has no
    // qualified access to another contract's events).
    event OracleRequest(
        bytes32 indexed specId,
        address requester,
        bytes32 requestId,
        uint256 payment,
        address callbackAddr,
        bytes4 callbackFunctionId,
        uint256 cancelExpiration,
        uint256 dataVersion,
        bytes data
    );
    event OracleResponse(bytes32 indexed requestId);
    event OracleCallbackResult(bytes32 indexed requestId, bool success, bytes returnData, uint256 gasAfter);
    event ReputationKeeperAdded(address indexed rk);
    event ReputationKeeperRemoved(address indexed rk);
    event AuthorizedSendersChanged(address[] senders, address changedBy);
    event OwnershipTransferRequested(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    function setUp() public virtual {
        link = new LinkTokenStandIn();
        keeper = new ReputationKeeperStandIn();
        consumer = new ConsumerStandIn(link);

        vm.startPrank(owner);
        operator = new ArbiterOperator(address(link));
        operator.setAuthorizedSenders(_addresses(node));
        operator.addReputationKeeper(address(keeper));
        vm.stopPrank();

        keeper.setApproved(address(consumer), true);
        link.mint(address(consumer), CONSUMER_LINK);
    }

    /// @notice A request from `consumer` paying `PAYMENT`.
    function _request() internal returns (Request memory) {
        return _request(consumer, PAYMENT);
    }

    /// @notice A request from `requester` paying `payment` LINK, which it must hold.
    function _request(ConsumerStandIn requester, uint256 payment) internal returns (Request memory r) {
        uint256 nonce = nextNonce++;
        requester.request(address(operator), payment, SPEC_ID, nonce, "");
        r = Request({
            id: keccak256(abi.encodePacked(address(requester), nonce)),
            payment: payment,
            callback: address(requester),
            callbackFunctionId: ConsumerStandIn.fulfill.selector,
            expiration: block.timestamp + operator.EXPIRYTIME()
        });
    }

    /// @notice The job's response for a request: abi.encode(requestId, scores, justification CID).
    function _response(Request memory r, uint256[] memory scores, string memory cid)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(r.id, scores, cid);
    }

    /// @notice A two-outcome response that puts 600,000 of the 1,000,000 on the first outcome.
    function _response(Request memory r) internal pure returns (bytes memory) {
        return _response(r, _scores(600_000, 400_000), "bafkreiexamplejustification");
    }

    /// @notice `r` fulfilled with `data` by the node, through fulfillOracleRequestV.
    function _fulfill(Request memory r, bytes memory data) internal returns (bool) {
        return _fulfillAs(node, r, data);
    }

    /// @notice `r` fulfilled with `data` by `sender`, through fulfillOracleRequestV.
    function _fulfillAs(address sender, Request memory r, bytes memory data) internal returns (bool) {
        vm.prank(sender);
        return operator.fulfillOracleRequestV(r.id, r.payment, r.callback, r.callbackFunctionId, r.expiration, data);
    }

    /// @notice Takes the keeper off the allow-list: the state an operator is deployed in.
    function _removeKeeper() internal {
        vm.prank(owner);
        operator.removeReputationKeeper(address(keeper));
    }

    function _scores(uint256 a, uint256 b) internal pure returns (uint256[] memory s) {
        s = new uint256[](2);
        s[0] = a;
        s[1] = b;
    }

    function _addresses(address a) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = a;
    }

    function _addresses(address a, address b) internal pure returns (address[] memory list) {
        list = new address[](2);
        list[0] = a;
        list[1] = b;
    }
}
