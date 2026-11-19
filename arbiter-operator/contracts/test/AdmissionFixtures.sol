// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// Exercise the actual pinned ERC-677 implementation, not a mock token callback.
import {LinkToken} from "@chainlink/contracts/src/v0.8/shared/token/ERC677/LinkToken.sol";

interface IRequestToken {
    function transferAndCall(address to, uint256 amount, bytes calldata data) external returns (bool);
}
interface IRequestCancellation {
    function cancelOracleRequest(bytes32 id, uint256 payment, bytes4 selector, uint256 expiry) external;
}

contract AdmissionRequester {
    uint256 public callbacks;
    function request(address token, address operator, uint256 amount, bytes calldata data) external {
        IRequestToken(token).transferAndCall(operator, amount, data);
    }
    function cancel(address operator, bytes32 id, uint256 amount, bytes4 selector, uint256 expiry) external {
        IRequestCancellation(operator).cancelOracleRequest(id, amount, selector, expiry);
    }
    function fulfill(bytes32, uint256[] calldata, string calldata) external { callbacks++; }
}

contract AdmissionKeeper {
    mapping(address => bool) public approved;
    uint256 public mode;
    function setApproved(address requester, bool value) external { approved[requester] = value; }
    function setMode(uint256 value) external { mode = value; }
    function isContractApproved(address requester) external view returns (bool) {
        uint256 current = mode;
        if (current == 1) revert("keeper unavailable");
        if (current == 2) assembly { mstore(0, 1) return(31, 1) }
        if (current == 3) assembly { mstore(0, 2) return(0, 32) }
        if (current == 4) assembly { mstore(0, 1) return(0, 64) }
        if (current == 5) assembly { for {} 1 {} {} }
        if (current == 6) assembly { return(0, 0) }
        return approved[requester];
    }
}
