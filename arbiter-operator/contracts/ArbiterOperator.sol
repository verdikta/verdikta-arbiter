// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/* ────────────────────────────────────────────────────────────── */
/*  Imports                                                      */
/* ────────────────────────────────────────────────────────────── */

import "./vendor/Operator.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/* ────────────────────────────────────────────────────────────── */
/*  External interfaces                                          */
/* ────────────────────────────────────────────────────────────── */

/// @notice Minimal view used by ArbiterOperator to consult allow-lists.
interface IReputationKeeper {
    function isContractApproved(address contractAddress) external view returns (bool);
}

/**
 * @title IArbiterOperator
 * @author Verdikta Team
 * @notice Marker interface for Verdikta ArbiterOperator with access control capabilities
 * @dev Specialized interface implemented ONLY by ArbiterOperator contracts.
 *      Provides multi-word response capability and ReputationKeeper integration.
 *      
 *      Interface ID = 0xbb303f0d, calculated as:
 *      bytes4(keccak256("fulfillOracleRequestV(bytes32,uint256,address,bytes4,uint256,bytes)"))
 *      ^ 0xc5b8e9fd  // isReputationKeeper(address)
 *      ^ 0x1d2566a8  // isReputationKeeperListEmpty()
 *      
 *      Standard Chainlink Operators return `false` for this interface ID.
 */
interface IArbiterOperator is IERC165 {
    /**
     * @notice Fulfill oracle request with multi-word response capability
     * @dev Extended fulfillment function that supports complex data responses
     * @param requestId The Chainlink request ID to fulfill
     * @param payment Payment amount in LINK tokens
     * @param callbackAddress Address of the contract to call back
     * @param callbackFunctionId Function selector to call on callback
     * @param expiration Request expiration timestamp
     * @param data Multi-word response data to send to callback
     * @return success Whether the callback was successful
     */
    function fulfillOracleRequestV(
        bytes32 requestId,
        uint256 payment,
        address callbackAddress,
        bytes4  callbackFunctionId,
        uint256 expiration,
        bytes   calldata data
    ) external returns (bool success);

    /**
     * @notice Check if an address is a registered ReputationKeeper
     * @dev Used by ReputationKeeper contracts to verify operator compliance
     * @param rkAddr Address to check
     * @return bool True if address is a registered ReputationKeeper
     */
    function isReputationKeeper(address rkAddr) external view returns (bool);
    
    /**
     * @notice Check if the ReputationKeeper allow-list is empty
     * @dev When empty, requests are denied until a keeper is configured
     * @return bool True if no ReputationKeepers are registered
     */
    function isReputationKeeperListEmpty() external view returns (bool);
}

/* ────────────────────────────────────────────────────────────── */
/*  ArbiterOperator                                              */
/* ────────────────────────────────────────────────────────────── */

/**
 * @title ArbiterOperator
 * @author Verdikta Team
 * @notice Specialized Chainlink Operator with access control and multi-word response support
 * @dev Extended Chainlink Operator that:
 *      1) Provides `fulfillOracleRequestV` for multi-word responses (complex data structures)
 *      2) Enforces access control via ReputationKeeper allow-list before oracle requests
 *      3) Implements IArbiterOperator interface for Verdikta ecosystem integration
 *      
 *      The minimally adapted, pinned Operator exposes request/payment hooks.
 *      Both inherited request entry points authorize the token-authenticated
 *      sender before storing a commitment or emitting OracleRequest.
 */
contract ArbiterOperator is Operator, ERC165, IArbiterOperator {
    /*──────────────  CONFIG  ──────────────*/

    /// Matches Chainlink upstream (node sends ≈500 k gas).
    uint256 private constant MY_MINIMUM_CONSUMER_GAS_LIMIT = 400_000;
    uint256 private constant KEEPER_QUERY_GAS = 50_000;

    /*────────  RK allow-list STORAGE  ─────*/

    mapping(address => bool) private rk;      // ReputationKeeper → true/false
    address[]               private rkList;   // enumeration for _approved()

    event ReputationKeeperAdded(address indexed rk);
    event ReputationKeeperRemoved(address indexed rk);

    /*────────  EVENTS (callback tracing)  ─*/

    event OracleCallbackAttempt(
        bytes32 indexed requestId,
        address callback,
        bytes4  selector,
        uint256 gasBefore
    );
    event OracleCallbackResult(
        bytes32 indexed requestId,
        bool     success,
        bytes    returnData,
        uint256  gasAfter
    );

    /*────────────  CONSTRUCTOR  ───────────*/

    constructor(address linkToken)
        Operator(linkToken, msg.sender)   // pass straight through
    {}

    /*────────────  RK management  ─────────*/

    /**
     * @notice Add a ReputationKeeper contract to the access control allow-list
     * @dev Only approved ReputationKeeper contracts can authorize consumer requests.
     *      Validates interface compliance before adding.
     * @param rkAddr Address of the ReputationKeeper contract to add
     */
    function addReputationKeeper(address rkAddr) external onlyOwner {
        require(rkAddr.code.length > 0, "RK: not contract");
        require(!rk[rkAddr],            "RK: exists");

        // sanity-check interface
        (bool valid, ) = _queryKeeper(rkAddr, address(this));
        require(valid, "RK: interface");

        rk[rkAddr] = true;
        rkList.push(rkAddr);
        emit ReputationKeeperAdded(rkAddr);
    }

    /**
     * @notice Remove a ReputationKeeper contract from the access control allow-list  
     * @dev Removes authorization capability for the specified ReputationKeeper
     * @param rkAddr Address of the ReputationKeeper contract to remove
     */
    function removeReputationKeeper(address rkAddr) external onlyOwner {
        require(rk[rkAddr], "RK: unknown");
        delete rk[rkAddr];

        for (uint256 i; i < rkList.length; ++i) {
            if (rkList[i] == rkAddr) {
                rkList[i] = rkList[rkList.length - 1];
                rkList.pop();
                break;
            }
        }
        emit ReputationKeeperRemoved(rkAddr);
    }

    /*────────────  public probes  ─────────*/

    /**
     * @notice Check if an address is a registered ReputationKeeper
     * @dev Part of IArbiterOperator interface for ReputationKeeper verification
     * @param rkAddr Address to check
     * @return bool True if address is in the ReputationKeeper allow-list
     */
    function isReputationKeeper(address rkAddr) external view override returns (bool) {
        return rk[rkAddr];
    }

    /**
     * @notice Check if the ReputationKeeper allow-list is empty
     * @dev When empty, requests fail closed
     * @return bool True if no ReputationKeepers are registered
     */
    function isReputationKeeperListEmpty() external view override returns (bool) {
        return rkList.length == 0;
    }

    /*────────── internal helper ───────────*/

    /**
     * @dev Check if a requester is approved by any registered ReputationKeeper
     * @param requester Address of the contract requesting oracle services
     * @return bool True only if approved by at least one valid ReputationKeeper
     */
    function _approved(address requester) internal view returns (bool) {
        if (requester.code.length == 0) return false;
        for (uint256 i; i < rkList.length; ++i) {
            (bool valid, bool approved) = _queryKeeper(rkList[i], requester);
            if (valid && approved) return true;
        }
        return false;
    }

    // Bound gas and copy at most one word. Reverts, empty/oversized responses
    // and noncanonical ABI booleans cannot open the gate or break another RK.
    function _queryKeeper(address keeper, address requester) private view returns (bool valid, bool approved) {
        bytes memory input = abi.encodeWithSelector(IReputationKeeper.isContractApproved.selector, requester);
        uint256 gasLimit = KEEPER_QUERY_GAS;
        bool ok;
        uint256 size;
        uint256 value;
        assembly {
            let output := mload(0x40)
            mstore(output, 0)
            ok := staticcall(gasLimit, keeper, add(input, 32), mload(input), output, 32)
            size := returndatasize()
            value := mload(output)
        }
        valid = ok && size == 32 && value <= 1;
        approved = valid && value == 1;
    }

    /// @notice Versioned installer probe; does not change the legacy ERC-165 marker.
    function requestAuthorizationVersion() external pure returns (uint256) { return 1; }

    function isRequesterApproved(address requester) external view returns (bool) {
        return _approved(requester);
    }

    /// @notice Pre-work/pre-transaction check for the exact event's pending request.
    /// @dev Chainlink filters logs by this operator and job. Cancelled, fulfilled,
    ///      expired, forged-parameter and currently revoked requests fail closed.
    function isAuthorizedRequest(
        bytes32 requestId, uint256 payment, address requester,
        bytes4 callbackFunctionId, uint256 expiration
    ) external view returns (bool) {
        Commitment memory commitment = s_commitments[requestId];
        return commitment.paramsHash != bytes31(0) && commitment.dataVersion == 2 &&
            block.timestamp < expiration &&
            commitment.paramsHash == _buildParamsHash(payment, requester, callbackFunctionId, expiration) &&
            _approved(requester);
    }

    /*────────── ERC-165 override ──────────*/

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC165, IERC165)
        returns (bool)
    {
        return
            interfaceId == type(IArbiterOperator).interfaceId || // 0xbb303f0d
            super.supportsInterface(interfaceId);
    }

    /*───────── Admission before commitment/event creation ───────────────*/
    function _verifyAndProcessOracleRequest(
        address sender, uint256 payment, address callbackAddress,
        bytes4 callbackFunctionId, uint256 nonce, uint256 dataVersion
    ) internal override returns (bytes32 requestId, uint256 expiration) {
        require(sender == callbackAddress, "Operator: callback must be requester");
        require(dataVersion == 2, "Operator: unsupported data version");
        require(_approved(sender), "Operator: requester not approved");
        return super._verifyAndProcessOracleRequest(
            sender, payment, callbackAddress, callbackFunctionId, nonce, dataVersion
        );
    }

    // Covers V and BOTH inherited fulfillment methods, so an alternative
    // fulfillment selector cannot bypass a keeper revocation.
    function _verifyOracleRequestAndProcessPayment(
        bytes32 requestId, uint256 payment, address callbackAddress,
        bytes4 callbackFunctionId, uint256 expiration, uint256 dataVersion
    ) internal override {
        require(_approved(callbackAddress), "Operator: requester not approved");
        super._verifyOracleRequestAndProcessPayment(
            requestId, payment, callbackAddress, callbackFunctionId, expiration, dataVersion
        );
    }

    /*──────── fulfillOracleRequestV ───────*/

    /// @inheritdoc IArbiterOperator
    function fulfillOracleRequestV(
        bytes32 requestId,
        uint256 payment,
        address callbackAddress,
        bytes4  callbackFunctionId,
        uint256 expiration,
        bytes   calldata data
    )
        external
        validateAuthorizedSender
        validateRequestId(requestId)
        validateCallbackAddress(callbackAddress)
        validateMultiWordResponseId(requestId, data)
        returns (bool success)
    {
        _verifyOracleRequestAndProcessPayment(
            requestId,
            payment,
            callbackAddress,
            callbackFunctionId,
            expiration,
            2 // dataVersion
        );

        emit OracleResponse(requestId);

        require(
            gasleft() >= MY_MINIMUM_CONSUMER_GAS_LIMIT,
            "Operator: not enough gas for consumer"
        );

        emit OracleCallbackAttempt(
            requestId,
            callbackAddress,
            callbackFunctionId,
            gasleft()
        );

        bytes memory ret;
        (success, ret) = callbackAddress.call(
            abi.encodePacked(callbackFunctionId, data)
        ); // solhint-disable-line avoid-low-level-calls

        emit OracleCallbackResult(requestId, success, ret, gasleft());
    }
}

