// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@chainlink/contracts/src/v0.8/ChainlinkClient.sol";

/**
 * @title AIChainlinkRequest
 * @dev This contract allows users to request AI evaluations via a Chainlink oracle.
 *      It supports the user-funded flow only: the caller must approve this contract
 *      for the fee amount, which is then used to pay the oracle.
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

    // Events
    event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);
    event FulfillAIEvaluation(bytes32 indexed requestId, uint256[] likelihoods, string justificationCID);
    event FulfillmentReceived(
        bytes32 indexed requestId, 
        address caller,
        uint256 likelihoodsLength,
        string justificationCID
    );

    /**
     * @notice Constructor sets up the Chainlink oracle parameters.
     * @param _oracle The address of the Chainlink oracle contract.
     * @param _jobId The job ID for the Chainlink request.
     * @param _fee The fee required to make a request (in LINK tokens).
     * @param _link The address of the LINK token contract.
     */
    constructor(address _oracle, bytes32 _jobId, uint256 _fee, address _link) {
        setChainlinkToken(_link);
        setChainlinkOracle(_oracle);
        oracle = _oracle;
        jobId = _jobId;
        fee = _fee;
    }

    /**
     * @notice Request an AI evaluation via the Chainlink oracle using user-funded LINK.
     *         Extra parameters are accepted but ignored.
     * @param cids An array of IPFS CIDs representing the data to be evaluated.
     * @return requestId The ID of the Chainlink request.
     */
    function requestAIEvaluationWithApproval(
        string[] memory cids,
        uint256,
        uint256,
        uint256,
        uint256
    ) public returns (bytes32 requestId) {
        require(cids.length > 0, "CIDs array must not be empty");

        // Pull exactly the fee amount from the caller.
        require(
            LinkTokenInterface(chainlinkTokenAddress()).transferFrom(msg.sender, address(this), fee),
            "transferFrom for fee failed"
        );

        // Build the Chainlink request.
        Chainlink.Request memory req = buildOperatorRequest(jobId, this.fulfill.selector);
        string memory cidsConcatenated = concatenateCids(cids);
        req.add("cid", cidsConcatenated);

        // Send the request using the fee just pulled from the caller.
        requestId = sendOperatorRequest(req, fee);
        emit RequestAIEvaluation(requestId, cids);
    }

    /**
     * @notice Callback function called by the Chainlink oracle with the AI evaluation results.
     * @param _requestId The ID of the Chainlink request.
     * @param likelihoods An array of integers representing the likelihoods of each option.
     * @param justificationCID The CID of the textual justification for the evaluation.
     */
    function fulfill(
        bytes32 _requestId,
        uint256[] memory likelihoods,
        string memory justificationCID
    ) public recordChainlinkFulfillment(_requestId) {
        emit FulfillmentReceived(
            _requestId, 
            msg.sender,
            likelihoods.length,
            justificationCID
        );
        require(likelihoods.length > 0, "Likelihoods array must not be empty");
        require(bytes(justificationCID).length > 0, "Justification CID must not be empty");

        // Store the evaluation results.
        evaluations[_requestId] = Evaluation({
            likelihoods: likelihoods,
            justificationCID: justificationCID,
            exists: true
        });

        emit FulfillAIEvaluation(_requestId, likelihoods, justificationCID);
    }

    /**
     * @notice Helper function to concatenate CIDs into a single string separated by commas.
     * @param cids An array of IPFS CIDs.
     * @return A single string containing all CIDs separated by commas.
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
     * @notice Returns the contract configuration.
     * @return oracleAddr The oracle address.
     * @return linkAddr The LINK token address.
     * @return jobid The Chainlink job ID.
     * @return currentFee The fee used for requests.
     */
    function getContractConfig() public view returns (
        address oracleAddr,
        address linkAddr,
        bytes32 jobid,
        uint256 currentFee
    ) {
        return (oracle, chainlinkTokenAddress(), jobId, fee);
    }

    /**
     * @notice Returns the evaluation results for a given request.
     * @param _requestId The ID of the Chainlink request.
     * @return likelihoods The likelihood values.
     * @return justificationCID The justification CID.
     * @return exists Whether the evaluation exists.
     */
    function getEvaluation(bytes32 _requestId) 
        public 
        view 
        returns (uint256[] memory likelihoods, string memory justificationCID, bool exists) 
    {
        Evaluation storage eval = evaluations[_requestId];
        return (eval.likelihoods, eval.justificationCID, eval.exists);
    }
} 