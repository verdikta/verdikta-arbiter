// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// @notice The vendored dependencies are exactly the bytes vendored.json records, and nothing else is
/// vendored. vendored.json also says where each file came from (an npm tarball, by its integrity, or a git
/// commit); CI compares every file with that source. This is the offline half, and it needs only the read
/// permission foundry.toml grants on arbiter-operator/foundry/lib.
contract VendoredFilesTest is Test {
    string internal constant LIB = "arbiter-operator/foundry/lib";
    string internal constant MANIFEST = "arbiter-operator/foundry/lib/vendored.json";

    struct VendoredFile {
        string path;
        bytes32 sha256;
    }

    function _files() internal view returns (VendoredFile[] memory) {
        bytes memory raw =
            vm.parseJsonTypeArray(vm.readFile(MANIFEST), ".files", "VendoredFile(string path,bytes32 sha256)");
        return abi.decode(raw, (VendoredFile[]));
    }

    function test_everyVendoredFileHasItsRecordedSha256() public view {
        VendoredFile[] memory files = _files();
        assertGt(files.length, 0, "vendored.json lists no file");
        for (uint256 i; i < files.length; ++i) {
            string memory path = string.concat(LIB, "/", files[i].path);
            assertEq(sha256(vm.readFileBinary(path)), files[i].sha256, path);
        }
    }

    function test_nothingElseIsVendored() public view {
        VendoredFile[] memory files = _files();
        for (uint256 i = 1; i < files.length; ++i) {
            assertTrue(_before(files[i - 1].path, files[i].path), "vendored.json paths are not unique and sorted");
        }
        VmSafe.DirEntry[] memory entries = vm.readDir(LIB, 64);
        uint256 regular;
        for (uint256 i; i < entries.length; ++i) {
            assertEq(entries[i].errorMessage, "", entries[i].path);
            assertFalse(entries[i].isSymlink, string.concat("a symbolic link: ", entries[i].path));
            if (!entries[i].isDir) ++regular;
        }
        // Each file vendored.json lists, and vendored.json itself.
        assertEq(regular, files.length + 1, "the files under arbiter-operator/foundry/lib are not the ones vendored.json lists");
    }

    /// @dev a sorts strictly before b, byte by byte.
    function _before(string memory a, string memory b) internal pure returns (bool) {
        bytes memory x = bytes(a);
        bytes memory y = bytes(b);
        uint256 n = x.length < y.length ? x.length : y.length;
        for (uint256 i; i < n; ++i) {
            if (x[i] != y[i]) return x[i] < y[i];
        }
        return x.length < y.length;
    }
}
