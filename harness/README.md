# harness

AIエージェントを安定して動かすための制御の仕組み(ハーネス)のうち、ツール非依存の資産を置く。

- rules/     絶対に守らせたい要件の宣言。可能な限りguards/の機械検証へ落とす
- templates/ 生成物が従うべき雛形・基底実装・参照コード例
- guards/    生成後・適用前に走らせる機械的検証(最終防衛線)。CIとhooksの両方から呼ぶ
- evals/     テスト観点チェックリスト・評価タスク・golden出力。ハーネス変更の回帰検知に使う
- artifacts/ step-summaryなどエージェント中間成果物の置き場(gitignore対象)

設計原則の詳細はbootstrap元skillの references/harness-structure.md を参照。
