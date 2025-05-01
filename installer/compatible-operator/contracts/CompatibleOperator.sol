// SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;

import "@chainlink/contracts/src/v0.7/Operator.sol";
import "@chainlink/contracts/src/v0.7/interfaces/OperatorInterface.sol";

/**
 * @title CompatibleOperator
 * @dev This contract extends the Chainlink Operator contract to provide
 * compatibility with client contracts using Chainlink 0.4.1
 */
contract CompatibleOperator is Operator {
    constructor(
        address link, 
        address owner
    ) 
        Operator(link, owner) 
    {}
    
    /**
     * @notice Custom fulfillment function for older Chainlink client contracts
     * @dev This function provides backwards compatibility with client contracts
     * that expect a specific signature
     */
    function fulfillOracleRequest3(
        bytes32 requestId,
        uint256 payment,
        address callbackAddress,
        bytes4 callbackFunctionId,
        uint256 expiration,
        bytes calldata data
    )
        external
        validateAuthorizedSender
        validateRequestId(requestId)
        validateCallbackAddress(callbackAddress)
        returns (bool)
    {
        _verifyOracleRequestAndProcessPayment(requestId, payment, callbackAddress, callbackFunctionId, expiration, 2);
        emit OracleResponse(requestId);
        require(gasleft() >= 400000, "Must provide consumer enough gas");
        (bool success, ) = callbackAddress.call(abi.encodePacked(callbackFunctionId, data));
        return success;
    }
} 