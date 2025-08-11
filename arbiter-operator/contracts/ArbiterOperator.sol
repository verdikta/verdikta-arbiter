// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/* ────────────────────────────────────────────────────────────── */
/*  Imports                                                      */
/* ────────────────────────────────────────────────────────────── */

import "@chainlink/contracts/src/v0.8/operatorforwarder/Operator.sol";
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
 *      Interface ID = 0xd9f812f9, calculated as:
 *      bytes4(keccak256("fulfillOracleRequestV(bytes32,uint256,address,bytes4,uint256,bytes)"))
 *      ^ 0x1132d7b2  // isReputationKeeper(address)  
 *      ^ 0xb7834e7d  // isReputationKeeperListEmpty()
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
     * @dev When empty, all requests are allowed (access control disabled)
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
 *      Note: Primary access control prior to OracleRequest emission requires
 *      a modified Operator with a pre-request hook. Since we now import the
 *      standard Chainlink Operator from npm, access control is enforced at
 *      fulfillment time and through secondary checks.
 */
contract ArbiterOperator is Operator, ERC165, IArbiterOperator {
    /*──────────────  CONFIG  ──────────────*/

    /// Matches Chainlink upstream (node sends ≈500 k gas).
    uint256 private constant MY_MINIMUM_CONSUMER_GAS_LIMIT = 400_000;

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
        (bool ok, ) = rkAddr.staticcall(
            abi.encodeWithSignature("isContractApproved(address)", address(this))
        );
        require(ok, "RK: interface");

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
     * @dev When empty, access control is disabled and all requests are allowed
     * @return bool True if no ReputationKeepers are registered
     */
    function isReputationKeeperListEmpty() external view override returns (bool) {
        return rkList.length == 0;
    }

    /*────────── internal helper ───────────*/

    /**
     * @dev Check if a requester is approved by any registered ReputationKeeper
     * @param requester Address of the contract requesting oracle services
     * @return bool True if approved by at least one ReputationKeeper, or if allow-list is empty
     */
    function _approved(address requester) internal view returns (bool) {
        if (rkList.length == 0) return true;               // gate disabled
        for (uint256 i; i < rkList.length; ++i) {
            (bool ok, bytes memory out) = rkList[i].staticcall(
                abi.encodeWithSignature("isContractApproved(address)", requester)
            );
            if (ok && abi.decode(out, (bool))) return true;
        }
        return false;
    }

    /*────────── ERC-165 override ──────────*/

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC165, IERC165)
        returns (bool)
    {
        return
            interfaceId == type(IArbiterOperator).interfaceId || // 0xd9f812f9
            super.supportsInterface(interfaceId);
    }

    /*───────── Pre-request hook (not available in upstream Operator) ──────*/
    // Upstream Operator does not expose a pre-request hook; access control is
    // enforced via fulfill-time checks and secondary validation below.

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
        // secondary check (paranoia): block if consumer no longer approved
        require(_approved(callbackAddress), "Operator: requester not approved");

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

