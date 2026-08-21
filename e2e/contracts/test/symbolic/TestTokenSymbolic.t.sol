// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestToken} from "../../src/TestToken.sol";

/**
 * @dev Symbolic properties, run by halmos (`halmos.toml` targets `.*Symbolic.*`).
 *
 *      TestToken is the e2e harness token, not a production contract — but the
 *      kit's eip3009 path trusts its state machine (balances, allowance,
 *      authorizationState), so the state machine is checked over all inputs.
 *      ecrecover is beyond practical symbolic scope; the signature path is
 *      covered concretely in TestToken.t.sol and by the e2e run.
 *
 *      Pattern: perform the operation under try/catch and assert what must
 *      hold on every accepting path. A revert is always acceptable.
 */
contract TestTokenSymbolic is Test {
    TestToken token;

    address internal holder = address(0xCA51);
    address internal spender = address(0x5BE4);

    function setUp() public {
        token = new TestToken("Sym", "SYM");
        token.mint(holder, 1e30);
    }

    /// @notice A transfer never changes the total supply.
    function check_transfer_preserves_totalSupply(address to, uint256 amount) public {
        uint256 supplyBefore = token.totalSupply();
        vm.prank(holder);
        try token.transfer(to, amount) {
            assert(token.totalSupply() == supplyBefore);
        } catch {}
    }

    /// @notice A successful transfer moves exactly `amount`.
    function check_transfer_moves_exact_amounts(address to, uint256 amount) public {
        vm.assume(to != holder);
        uint256 fromBefore = token.balanceOf(holder);
        uint256 toBefore = token.balanceOf(to);
        vm.prank(holder);
        try token.transfer(to, amount) {
            assert(token.balanceOf(holder) == fromBefore - amount);
            assert(token.balanceOf(to) == toBefore + amount);
        } catch {}
    }

    /// @notice A transfer cannot succeed for more than the sender holds.
    function check_transfer_never_overdraws(address to, uint256 amount) public {
        uint256 fromBefore = token.balanceOf(holder);
        vm.prank(holder);
        try token.transfer(to, amount) {
            assert(amount <= fromBefore);
        } catch {}
    }

    /// @notice transferFrom (the Permit2 pull) consumes exactly `amount` of a finite allowance
    ///         and leaves an infinite allowance untouched.
    function check_transferFrom_consumes_allowance(address to, uint256 allowed, uint256 amount) public {
        vm.assume(to != holder);
        vm.prank(holder);
        token.approve(spender, allowed);
        vm.prank(spender);
        try token.transferFrom(holder, to, amount) {
            assert(amount <= allowed);
            if (allowed == type(uint256).max) assert(token.allowance(holder, spender) == allowed);
            else assert(token.allowance(holder, spender) == allowed - amount);
        } catch {}
    }

    /// @notice Only the minter can mint — a successful mint always came from it.
    function check_mint_is_minter_only(address caller, address to, uint256 amount) public {
        uint256 supplyBefore = token.totalSupply();
        vm.prank(caller);
        try token.mint(to, amount) {
            assert(caller == token.minter());
            assert(token.totalSupply() == supplyBefore + amount);
        } catch {}
    }

    /// @notice A consumed authorization can never be consumed again — the on-chain
    ///         replay guard the kit's eip3009 settle relies on. The nonce is marked
    ///         used directly in storage (no signing in symbolic scope); the
    ///         property is that every call for it then reverts, whatever else is passed.
    function check_used_authorization_always_reverts(
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes memory signature
    ) public {
        bytes32 nonce = bytes32(uint256(0x1234));
        // authorizationState is the 6th declared storage variable (slot 5)
        bytes32 slot = keccak256(abi.encode(nonce, keccak256(abi.encode(holder, uint256(5)))));
        vm.store(address(token), slot, bytes32(uint256(1)));
        assert(token.authorizationState(holder, nonce));
        try token.transferWithAuthorization(holder, to, value, validAfter, validBefore, nonce, signature) {
            assert(false);
        } catch {}
    }

    /// @notice Outside (validAfter, validBefore) an authorization is never accepted.
    function check_authorization_respects_time_window(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) public {
        vm.assume(block.timestamp <= validAfter || block.timestamp >= validBefore);
        try token.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature) {
            assert(false);
        } catch {}
    }
}
