// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// import "https://raw.githubusercontent.com/smartcontractkit/chainlink/master/contracts/src/v0.8/operatorforwarder/Operator.sol";
import "../lib/chainlink/src/v0.8/operatorforwarder/Operator.sol";

contract ArbiterOperator is Operator {
    /*──────────────────────  CONFIG  ──────────────────────*/

    /// Matches Chainlink upstream default (node sends 500 000 gas)
    uint256 private constant MY_MINIMUM_CONSUMER_GAS_LIMIT = 400_000;

    /*──────────────────────  EVENTS  ───────────────────────*/

    /// Emitted just before the external callback
    event OracleCallbackAttempt(
        bytes32 indexed requestId,
        address callback,
        bytes4  selector,
        uint256 gasBefore
    );

    /// Emitted right after the external callback returns
    event OracleCallbackResult(
        bytes32 indexed requestId,
        bool     success,
        bytes    returnData,
        uint256  gasAfter
    );

    /*──────────────────────  CONSTRUCTOR  ─────────────────*/

    constructor(address linkToken) Operator(linkToken, msg.sender) {}

    /*───────────────────  FULFILMENT v3  ───────────────────*/

    function fulfillOracleRequest3(
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
            2   // dataVersion
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

