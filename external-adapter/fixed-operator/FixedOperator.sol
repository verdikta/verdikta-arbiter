// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/LinkTokenInterface.sol";
import "./interfaces/OperatorInterface.sol";
import "./interfaces/OracleInterface.sol";

/**
 * @title The Chainlink Operator contract with fixed fulfillOracleRequest3
 * @notice Node operators can deploy this contract to fulfill requests sent to them
 */
contract FixedOperator is OracleInterface, OperatorInterface {
  LinkTokenInterface internal immutable linkToken;
  address private owner;
  
  // Mapping of authorized node addresses
  mapping(address => bool) private authorizedNodes;
  
  // Mapping of fulfillment permissions
  mapping(address => mapping(bytes4 => bool)) private fulfillmentPermissions;
  
  constructor(address link) {
    linkToken = LinkTokenInterface(link);
    owner = msg.sender;
  }
  
  // Implement OracleInterface
  function cancel(bytes32 requestId) external override {
    // No implementation needed for this version
  }
  
  function fulfillOracleRequest(
    bytes32 requestId,
    uint256 payment,
    address callbackAddress,
    bytes4 callbackFunctionId,
    uint256 expiration,
    bytes32 data
  ) external override returns (bool) {
    require(authorizedNodes[msg.sender], "Not authorized");
    (bool success, ) = callbackAddress.call(abi.encodeWithSelector(callbackFunctionId, requestId, data));
    return success;
  }
  
  // Implement OperatorInterface
  function operatorRequest(
    address sender,
    uint256 payment,
    bytes32 specId,
    bytes4 callbackFunctionId,
    uint256 nonce,
    uint256 dataVersion,
    bytes calldata data
  ) external override {
    // No implementation needed for this version
  }
  
  function fulfillOracleRequest2(
    bytes32 requestId,
    uint256 payment,
    address callbackAddress,
    bytes4 callbackFunctionId,
    uint256 expiration,
    bytes calldata data
  ) external override returns (bool) {
    require(authorizedNodes[msg.sender], "Not authorized");
    (bool success, ) = callbackAddress.call(abi.encodePacked(callbackFunctionId, data));
    return success;
  }
  
  function ownerTransferAndCall(
    address to,
    uint256 value,
    bytes calldata data
  ) external override returns (bool) {
    require(msg.sender == owner, "Not owner");
    return linkToken.transferAndCall(to, value, data);
  }
  
  function distributeFunds(
    address payable[] calldata receivers,
    uint256[] calldata amounts
  ) external override onlyOwner {
    require(receivers.length == amounts.length, "Invalid array length");
    for (uint256 i = 0; i < receivers.length; i++) {
      receivers[i].transfer(amounts[i]);
    }
  }
  
  function getAuthorizedSenders() external view override returns (address[] memory) {
    // Implement with proper array sizing for production
    address[] memory senders = new address[](1);
    return senders;
  }
  
  function setAuthorizedSenders(address[] calldata senders) external override onlyOwner {
    for (uint i = 0; i < senders.length; i++) {
      authorizedNodes[senders[i]] = true;
    }
  }
  
  function getChainlinkToken() external view override returns (address) {
    return address(linkToken);
  }
  
  /**
   * @dev THIS IS THE FIXED FUNCTION - Using encodeWithSelector instead of encodePacked
   */
  function fulfillOracleRequest3(
    bytes32 requestId,
    uint256 payment,
    address callbackAddress,
    bytes4 callbackFunctionId,
    uint256 expiration,
    bytes calldata data
  ) external returns (bool) {
    require(authorizedNodes[msg.sender], "Not authorized");
    require(gasleft() >= 400000, "Must provide consumer enough gas");
    
    // FIXED: Use encodeWithSelector to properly include requestId in the callback
    (bool success, ) = callbackAddress.call(abi.encodeWithSelector(callbackFunctionId, requestId, data));
    return success;
  }
  
  modifier onlyOwner() {
    require(msg.sender == owner, "Not owner");
    _;
  }
} 