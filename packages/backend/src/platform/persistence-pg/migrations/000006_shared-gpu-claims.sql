-- A GPU is shared like CPU: any number of containers whose owners are granted
-- the card may bind it at once, so a card is no longer unique per server. The
-- server_id index keeps the occupancy count and the disable trigger cheap.
ALTER TABLE control.container_gpu_claims
    DROP CONSTRAINT container_gpu_claims_server_pci_key;

CREATE INDEX container_gpu_claims_server_idx
    ON control.container_gpu_claims (server_id, pci_address);
