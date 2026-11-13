-- Iteration 3, stage 2c: an exact "unshared changes" marker.
-- shared_counter is the working copy's save_counter at the last share (or
-- replace). A working copy has unshared changes when save_counter is greater.
ALTER TABLE working_copies ADD COLUMN shared_counter INTEGER NOT NULL DEFAULT 0;
