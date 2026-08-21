// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestToken} from "../src/TestToken.sol";

/// Concrete checks of the signature path the symbolic suite cannot reach.
contract TestTokenTest is Test {
    TestToken token;
    uint256 internal buyerKey = 0xB0B;
    address internal buyer;
    address internal seller = address(0x5E11);

    bytes32 private constant TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function setUp() public {
        token = new TestToken("Test", "TST");
        buyer = vm.addr(buyerKey);
        token.mint(buyer, 1_000_000);
        vm.warp(1_800_000_000);
    }

    function _sign(uint256 key, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(TYPEHASH, vm.addr(key), to, value, validAfter, validBefore, nonce))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_transferWithAuthorization_moves_funds_and_marks_nonce() public {
        bytes32 nonce = bytes32(uint256(1));
        bytes memory sig = _sign(buyerKey, seller, 10_000, block.timestamp - 1, block.timestamp + 60, nonce);
        vm.expectEmit(true, true, false, false);
        emit TestToken.AuthorizationUsed(buyer, nonce);
        token.transferWithAuthorization(buyer, seller, 10_000, block.timestamp - 1, block.timestamp + 60, nonce, sig);
        assertEq(token.balanceOf(seller), 10_000);
        assertTrue(token.authorizationState(buyer, nonce));
    }

    function test_replay_reverts() public {
        bytes32 nonce = bytes32(uint256(2));
        bytes memory sig = _sign(buyerKey, seller, 1, block.timestamp - 1, block.timestamp + 60, nonce);
        token.transferWithAuthorization(buyer, seller, 1, block.timestamp - 1, block.timestamp + 60, nonce, sig);
        vm.expectRevert("authorization used");
        token.transferWithAuthorization(buyer, seller, 1, block.timestamp - 1, block.timestamp + 60, nonce, sig);
    }

    function test_wrong_signer_reverts() public {
        bytes32 nonce = bytes32(uint256(3));
        bytes memory sig = _sign(0xE5E, seller, 1, block.timestamp - 1, block.timestamp + 60, nonce);
        vm.expectRevert("invalid signature");
        token.transferWithAuthorization(buyer, seller, 1, block.timestamp - 1, block.timestamp + 60, nonce, sig);
    }

    function test_tampered_amount_reverts() public {
        bytes32 nonce = bytes32(uint256(4));
        bytes memory sig = _sign(buyerKey, seller, 1, block.timestamp - 1, block.timestamp + 60, nonce);
        vm.expectRevert("invalid signature");
        token.transferWithAuthorization(buyer, seller, 2, block.timestamp - 1, block.timestamp + 60, nonce, sig);
    }
}
