pragma solidity ^0.8.0;

import "https://raw.githubusercontent.com/smartcontractkit/chainlink/master/contracts/src/v0.8/operatorforwarder/Operator.sol";

contract MyOperator is Operator {
    // Define your own minimum gas limit constant
    uint256 private constant MY_MINIMUM_CONSUMER_GAS_LIMIT = 400000;

    constructor(address link) Operator(link, msg.sender) {}

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
       validateMultiWordResponseId(requestId, data)
       returns (bool)
   {
       _verifyOracleRequestAndProcessPayment(requestId, payment, callbackAddress, callbackFunctionId, expiration, 2);
       emit OracleResponse(requestId);
       require(gasleft() >= MY_MINIMUM_CONSUMER_GAS_LIMIT, "Must provide consumer enough gas"); // or your chosen constant
       (bool success, ) = callbackAddress.call(abi.encodePacked(callbackFunctionId, data));
       return success;
   }
}

