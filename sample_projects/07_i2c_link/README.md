# I2C Link Sample

This sample models a simple single-master I2C write transaction.

- `i2c_link_top.v`: top-level wrapper that connects the master and slave to a shared bus
- `i2c_master_write.v`: byte-oriented I2C master that issues start, address, data, and stop
- `i2c_slave_device.v`: minimal I2C slave that ACKs one 7-bit address and captures a data byte

The design is intentionally small and only supports one write transfer shape:

- 7-bit address
- write bit (`R/W = 0`)
- one data byte
- ACK after address and data

No testbenches are included in this sample.
