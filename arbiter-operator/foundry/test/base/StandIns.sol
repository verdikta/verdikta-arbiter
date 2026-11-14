// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {LinkTokenInterface} from "@chainlink/contracts/src/v0.8/shared/interfaces/LinkTokenInterface.sol";
import {OperatorInterface} from "@chainlink/contracts/src/v0.8/operatorforwarder/interfaces/OperatorInterface.sol";

/// @notice ERC-677's receiver hook, which LINK's transferAndCall calls on a contract recipient.
interface ITokenReceiver {
    function onTokenTransfer(address sender, uint256 amount, bytes calldata data) external;
}

/// @title LinkTokenStandIn
/// @notice A stand-in for the LINK token: ERC-20 balances and allowances, and ERC-677's transferAndCall,
/// which is how a request reaches the operator. Anyone may mint. It has no fallback.
contract LinkTokenStandIn is LinkTokenInterface {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public override totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value, bytes data);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function name() external pure override returns (string memory) {
        return "ChainLink Token stand-in";
    }

    function symbol() external pure override returns (string memory) {
        return "LINK";
    }

    function decimals() external pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external override returns (bool) {
        allowance[from][msg.sender] -= value;
        _move(from, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external override returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function increaseApproval(address spender, uint256 addedValue) external override {
        allowance[msg.sender][spender] += addedValue;
        emit Approval(msg.sender, spender, allowance[msg.sender][spender]);
    }

    function decreaseApproval(address spender, uint256 subtractedValue) external override returns (bool) {
        uint256 current = allowance[msg.sender][spender];
        allowance[msg.sender][spender] = subtractedValue > current ? 0 : current - subtractedValue;
        emit Approval(msg.sender, spender, allowance[msg.sender][spender]);
        return true;
    }

    /// @notice ERC-677: a transfer, then onTokenTransfer on the recipient when it is a contract.
    function transferAndCall(address to, uint256 value, bytes calldata data) external override returns (bool) {
        _move(msg.sender, to, value);
        emit Transfer(msg.sender, to, value, data);
        if (to.code.length > 0) ITokenReceiver(to).onTokenTransfer(msg.sender, value, data);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// @title ReputationKeeperStandIn
/// @notice A stand-in for the dispatcher's ReputationKeeper, as far as the operator reads it:
/// isContractApproved. Anyone may set the answers.
contract ReputationKeeperStandIn {
    mapping(address => bool) public approved;

    function setApproved(address requester, bool ok) external {
        approved[requester] = ok;
    }

    function isContractApproved(address requester) external view returns (bool) {
        return approved[requester];
    }
}

/// @title ConsumerStandIn
/// @notice A requester: it pays for a request with LINK's transferAndCall, as Chainlink clients do
/// (operatorRequest, data version 2), and records the multi-word response the operator delivers to
/// fulfill(requestId, scores, justification CID), the shape the arbiter's job encodes.
contract ConsumerStandIn {
    LinkTokenInterface public immutable link;

    bool public refuse;
    uint256 public fulfillments;
    address public lastCaller;
    bytes32 public lastRequestId;
    uint256[] internal _lastScores;
    string public lastCid;

    constructor(LinkTokenInterface link_) {
        link = link_;
    }

    /// @notice Makes the next fulfill() revert.
    function setRefuse(bool refuse_) external {
        refuse = refuse_;
    }

    /// @notice Sends a request to `operator` paying `payment`; its id is keccak256(this, nonce).
    function request(address operator, uint256 payment, bytes32 specId, uint256 nonce, bytes calldata data)
        external
    {
        // The operator overwrites the sender and amount words with the transfer's own.
        bytes memory call = abi.encodeWithSelector(
            OperatorInterface.operatorRequest.selector, address(0), 0, specId, this.fulfill.selector, nonce, 2, data
        );
        require(link.transferAndCall(operator, payment, call), "consumer: transferAndCall failed");
    }

    function fulfill(bytes32 requestId, uint256[] calldata scores, string calldata cid) external {
        require(!refuse, "consumer: refused");
        ++fulfillments;
        lastCaller = msg.sender;
        lastRequestId = requestId;
        _lastScores = scores;
        lastCid = cid;
    }

    function lastScores() external view returns (uint256[] memory) {
        return _lastScores;
    }
}
