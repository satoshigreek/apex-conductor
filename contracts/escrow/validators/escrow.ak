//// Apex Conductor — per-task escrow validator (SPEC §5.2 Payments v2, M4).
////
//// Lifecycle:
////   lock    — conductor locks the task budget at this script with an inline EscrowDatum
////   Release — before the deadline, the conductor releases per-step agent fees; any change
////             paid back to the script MUST carry the unchanged datum (continuation rule)
////   Refund  — after the deadline, the refund key reclaims whatever remains
////   Dispute — conductor AND refund keys co-sign (2-of-2) to settle at any time
////
//// AUDIT SCOPE (before mainnet, SPEC M4): full per-step value accounting on Release,
//// dispute timelock window, and double-satisfaction analysis across concurrent tasks.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Finite}
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder}

pub type EscrowDatum {
  /// Conductor task id (UUID bytes) — one escrow UTxO per task
  task_id: ByteArray,
  /// key allowed to release agent fees before the deadline
  conductor: VerificationKeyHash,
  /// POSIX time (ms): releases stop, refunds start
  deadline: Int,
  /// key allowed to reclaim after the deadline
  refund: VerificationKeyHash,
}

pub type EscrowRedeemer {
  Release
  Refund
  Dispute
}

fn signed_by(tx: Transaction, key: VerificationKeyHash) -> Bool {
  list.has(tx.extra_signatories, key)
}

/// Tx must be guaranteed to execute strictly before `t` (finite upper bound <= t).
fn ends_before(tx: Transaction, t: Int) -> Bool {
  when tx.validity_range.upper_bound.bound_type is {
    Finite(upper) -> upper <= t
    _ -> False
  }
}

/// Tx must be guaranteed to execute strictly after `t` (finite lower bound > t).
fn starts_after(tx: Transaction, t: Int) -> Bool {
  when tx.validity_range.lower_bound.bound_type is {
    Finite(lower) -> lower > t
    _ -> False
  }
}

/// Continuation rule: any output paying back to this script address must carry the
/// SAME inline datum — a partial release cannot rewrite the task's escrow terms.
fn continuation_preserves_datum(
  tx: Transaction,
  utxo: OutputReference,
  datum: EscrowDatum,
) -> Bool {
  expect Some(own_input) =
    list.find(tx.inputs, fn(input) { input.output_reference == utxo })
  let own_address = own_input.output.address
  list.all(
    tx.outputs,
    fn(output) {
      if output.address == own_address {
        output.datum == InlineDatum(datum)
      } else {
        True
      }
    },
  )
}

validator escrow {
  spend(
    datum: Option<EscrowDatum>,
    redeemer: EscrowRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    expect Some(d) = datum
    when redeemer is {
      Release ->
        signed_by(self, d.conductor) && ends_before(self, d.deadline) && continuation_preserves_datum(
          self,
          utxo,
          d,
        )
      Refund -> signed_by(self, d.refund) && starts_after(self, d.deadline)
      Dispute -> signed_by(self, d.conductor) && signed_by(self, d.refund)
    }
  }

  else(_) {
    fail
  }
}

// ───────────────────────── tests (aiken check) ─────────────────────────

const conductor_key = #"c24fac4c7298c0a8a82d26d1e97cb0444c780be98074d5efc2adc01e"

const refund_key = #"a4baa08788dccaec36e5a509c3a9a278ec91fe530a5b8925815a6910"

const stranger_key = #"d5f092977b39514ef2afd2a232267dd9639db9743d5bff916b4531a7"

const script_hash = #"11111111111111111111111111111111111111111111111111111111"

const deadline = 1_780_000_000_000

fn sample_datum() -> EscrowDatum {
  EscrowDatum { task_id: "task-1", conductor: conductor_key, deadline, refund: refund_key }
}

fn own_ref() -> OutputReference {
  OutputReference { transaction_id: #"00", output_index: 0 }
}

fn script_address() -> Address {
  Address { payment_credential: Script(script_hash), stake_credential: None }
}

fn own_input() -> Input {
  Input {
    output_reference: own_ref(),
    output: Output {
      address: script_address(),
      value: assets.from_lovelace(100_000_000),
      datum: InlineDatum(sample_datum()),
      reference_script: None,
    },
  }
}

fn agent_output() -> Output {
  Output {
    address: Address { payment_credential: VerificationKey(stranger_key), stake_credential: None },
    value: assets.from_lovelace(5_000_000),
    datum: NoDatum,
    reference_script: None,
  }
}

fn continuation_output(d: EscrowDatum) -> Output {
  Output {
    address: script_address(),
    value: assets.from_lovelace(95_000_000),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

test release_by_conductor_before_deadline_with_continuation() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [own_input()],
      outputs: [agent_output(), continuation_output(sample_datum())],
      extra_signatories: [conductor_key],
      validity_range: interval.before(deadline - 1),
    }
  escrow.spend(Some(sample_datum()), Release, own_ref(), tx)
}

test release_fails_without_conductor_signature() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [own_input()],
      outputs: [agent_output()],
      extra_signatories: [stranger_key],
      validity_range: interval.before(deadline - 1),
    }
  escrow.spend(Some(sample_datum()), Release, own_ref(), tx)
}

test release_fails_after_deadline() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [own_input()],
      outputs: [agent_output()],
      extra_signatories: [conductor_key],
      validity_range: interval.after(deadline + 1),
    }
  escrow.spend(Some(sample_datum()), Release, own_ref(), tx)
}

test release_fails_with_unbounded_validity() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [own_input()],
      outputs: [agent_output()],
      extra_signatories: [conductor_key],
      validity_range: interval.everything,
    }
  escrow.spend(Some(sample_datum()), Release, own_ref(), tx)
}

test release_fails_when_continuation_rewrites_datum() fail {
  let tampered = EscrowDatum { ..sample_datum(), conductor: stranger_key }
  let tx =
    Transaction {
      ..placeholder,
      inputs: [own_input()],
      outputs: [agent_output(), continuation_output(tampered)],
      extra_signatories: [conductor_key],
      validity_range: interval.before(deadline - 1),
    }
  escrow.spend(Some(sample_datum()), Release, own_ref(), tx)
}

test refund_by_refund_key_after_deadline() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [own_input()],
      outputs: [agent_output()],
      extra_signatories: [refund_key],
      validity_range: interval.after(deadline + 1),
    }
  escrow.spend(Some(sample_datum()), Refund, own_ref(), tx)
}

test refund_fails_before_deadline() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [own_input()],
      outputs: [agent_output()],
      extra_signatories: [refund_key],
      validity_range: interval.before(deadline - 1),
    }
  escrow.spend(Some(sample_datum()), Refund, own_ref(), tx)
}

test refund_fails_for_stranger() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [own_input()],
      outputs: [agent_output()],
      extra_signatories: [stranger_key],
      validity_range: interval.after(deadline + 1),
    }
  escrow.spend(Some(sample_datum()), Refund, own_ref(), tx)
}

test dispute_with_both_signatures_any_time() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [own_input()],
      outputs: [agent_output()],
      extra_signatories: [conductor_key, refund_key],
      validity_range: interval.everything,
    }
  escrow.spend(Some(sample_datum()), Dispute, own_ref(), tx)
}

test dispute_fails_with_single_signature() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [own_input()],
      outputs: [agent_output()],
      extra_signatories: [conductor_key],
      validity_range: interval.everything,
    }
  escrow.spend(Some(sample_datum()), Dispute, own_ref(), tx)
}
