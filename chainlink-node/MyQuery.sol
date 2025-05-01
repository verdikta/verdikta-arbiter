// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

// Import the Chainlink client contract
import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";

/**
 * @title AIChainlinkRequest
 * @dev This contract allows users to request AI evaluations via a Chainlink oracle.
 */
contract AIChainlinkRequest is ChainlinkClient {
    using Chainlink for Chainlink.Request;

    // Oracle and job specifications
    address private oracle;
    bytes32 private jobId;
    uint256 private fee;

    // Mapping from requestId to evaluation result
    mapping(bytes32 => Evaluation) public evaluations;

    // Struct to store evaluation results
    struct Evaluation {
        uint256[] likelihoods;
        string justificationCID;
        bool exists;
    }

function getEvaluation(bytes32 _requestId) 
    public 
    view 
    returns (uint256[] memory likelihoods, string memory justificationCID, bool exists) 
{
    Evaluation storage eval = evaluations[_requestId];
    return (eval.likelihoods, eval.justificationCID, eval.exists);
}

    // Events
    event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);
    event FulfillAIEvaluation(bytes32 indexed requestId, uint256[] likelihoods, string justificationCID);

    /**
     * @notice Constructor sets up the Chainlink oracle parameters
     * @param _oracle The address of the Chainlink oracle contract
     * @param _jobId The job ID for the Chainlink request
     * @param _fee The fee required to make a request (in LINK tokens)
     * @param _link The address of the LINK token contract
     */
    constructor(address _oracle, bytes32 _jobId, uint256 _fee, address _link) {
        setChainlinkToken(_link);
        setChainlinkOracle(_oracle);
        oracle = _oracle;
        jobId = _jobId;
        fee = _fee;

    LinkTokenInterface link = LinkTokenInterface(_link);
    require(link.approve(_oracle, 2**256 - 1), "Failed to approve LINK");

    }

    /**
     * @notice Request an AI evaluation via the Chainlink oracle
     * @param cids An array of IPFS CIDs representing the data to be evaluated
     * @return requestId The ID of the Chainlink request
     */
    function requestAIEvaluation(string[] memory cids) public returns (bytes32 requestId) {
        require(cids.length > 0, "CIDs array must not be empty");

    // Add debug checks
    address linkAddress = chainlinkTokenAddress();
    uint256 linkBalance = LinkTokenInterface(linkAddress).balanceOf(address(this));

    require(linkAddress != address(0), "LINK token not initialized");
    require(oracle != address(0), "Oracle not set");
    require(fee > 0, "Fee not set");
    
    // Log current state
    emit Debug(chainlinkTokenAddress(), oracle, fee);

    emit Debug1(
        linkAddress,        // LINK token address
        oracle,            // Oracle address
        fee,              // Fee amount
        linkBalance,      // Current LINK balance
        jobId             // Job ID
    );

        // Build the Chainlink request
        // Chainlink.Request memory request = buildChainlinkRequest(jobId, address(this), this.fulfill.selector);
        Chainlink.Request memory request = buildOperatorRequest(jobId, this.fulfill.selector);

        // Concatenate CIDs into a single string with comma delimiter
        string memory cidsConcatenated = concatenateCids(cids);

        // Add the concatenated CIDs to the request parameters
        // request.add("cids", cidsConcatenated);
        request.add("cid", cidsConcatenated);

        // Send the request to the Chainlink oracle
        //requestId = sendChainlinkRequestTo(oracle, request, fee);
        requestId = sendOperatorRequest(request, fee);

        emit RequestAIEvaluation(requestId, cids);
    }

event Debug(address linkToken, address oracle, uint256 fee);
event Debug1(
    address linkToken,
    address oracle,
    uint256 fee,
    uint256 balance,
    bytes32 jobId
);



    /**
     * @notice Callback function called by the Chainlink oracle with the AI evaluation results
     * @param _requestId The ID of the Chainlink request
     * @param likelihoods An array of integers representing the likelihoods of each option
     * @param justificationCID The CID of the textual justification for the evaluation
     */
    function fulfill(
        bytes32 _requestId,
        uint256[] memory likelihoods,
        string memory justificationCID
    ) public recordChainlinkFulfillment(_requestId) {

    emit FulfillmentReceived(
        _requestId, 
        msg.sender,  // This will show which address is calling fulfill
        likelihoods.length,
        justificationCID
    );
        require(likelihoods.length > 0, "Likelihoods array must not be empty");
        require(bytes(justificationCID).length > 0, "Justification CID must not be empty");

        // Store the evaluation results
        evaluations[_requestId] = Evaluation({
            likelihoods: likelihoods,
            justificationCID: justificationCID,
            exists: true
        });

        emit FulfillAIEvaluation(_requestId, likelihoods, justificationCID);
    }

event FulfillmentReceived(
    bytes32 indexed requestId, 
    address caller,
    uint256 likelihoodsLength,
    string justificationCID
);

    /**
     * @notice Helper function to concatenate CIDs into a single string separated by commas
     * @param cids An array of IPFS CIDs
     * @return A single string containing all CIDs separated by commas
     */
    function concatenateCids(string[] memory cids) internal pure returns (string memory) {
        bytes memory concatenatedCids;

        for (uint256 i = 0; i < cids.length; i++) {
            concatenatedCids = abi.encodePacked(concatenatedCids, cids[i]);
            if (i < cids.length - 1) {
                concatenatedCids = abi.encodePacked(concatenatedCids, ",");
            }
        }

        return string(concatenatedCids);
    }

    /**
     * @notice Allows the contract owner to withdraw any LINK tokens held by the contract
     * @dev Implement this function if needed to recover excess LINK tokens
     * @param _to The address to send the LINK tokens to
     * @param _amount The amount of LINK tokens to withdraw
     */
    function withdrawLink(address payable _to, uint256 _amount) external {
        require(_to != address(0), "Invalid recipient address");
        LinkTokenInterface linkToken = LinkTokenInterface(chainlinkTokenAddress());
        require(linkToken.transfer(_to, _amount), "Unable to transfer");
    }

    function getContractConfig() public view returns (
        address oracleAddr,
        address linkAddr,
        bytes32 jobid,
        uint256 currentFee
    ) {
        return (oracle, chainlinkTokenAddress(), jobId, fee);
    }
}

