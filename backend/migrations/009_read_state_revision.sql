-- HTTP acknowledgements, ready snapshots and live mentions may arrive in any order.
ALTER TABLE read_states ADD COLUMN revision bigint NOT NULL DEFAULT 0;
