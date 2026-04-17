module i2c_link_top #(
    parameter integer CLK_DIV = 8,
    // Backwards-compatible single-slave parameter name.
    parameter [6:0] SLAVE_ADDRESS  = 7'h42,
    // Additional slave addresses.
    parameter [6:0] SLAVE1_ADDRESS = 7'h43,
    parameter [6:0] SLAVE2_ADDRESS = 7'h44
) (
    input wire clk,
    input wire rst,
    input wire start_write,
    // Select which slave to target (0/1/2). If left unconnected, it will be treated as 0.
    input wire [1:0] slave_sel,
    input wire [7:0] tx_data,
    output wire busy,
    output wire done,
    output wire ack_error,
    // Legacy single-slave outputs
    output wire [7:0] slave_rx_data,
    output wire slave_rx_valid,
    // New per-slave outputs
    output wire [7:0] slave0_rx_data,
    output wire slave0_rx_valid,
    output wire [7:0] slave1_rx_data,
    output wire slave1_rx_valid,
    output wire [7:0] slave2_rx_data,
    output wire slave2_rx_valid,
    output wire i2c_scl,
    output wire i2c_sda
);
    wire master_scl_drive_low;
    wire master_sda_drive_low;
    wire slave0_sda_drive_low;
    wire slave1_sda_drive_low;
    wire slave2_sda_drive_low;

    // Treat X/Z as 0 for backwards compatibility when slave_sel is unconnected.
    wire [1:0] slave_sel_i = (slave_sel === 2'b01) ? 2'd1 :
                             (slave_sel === 2'b10) ? 2'd2 :
                             2'd0;

    wire [6:0] selected_addr = (slave_sel_i == 2'd1) ? SLAVE1_ADDRESS :
                               (slave_sel_i == 2'd2) ? SLAVE2_ADDRESS :
                               SLAVE_ADDRESS;

    // Backwards-compatible aliases: legacy outputs follow slave0.
    assign slave_rx_data  = slave0_rx_data;
    assign slave_rx_valid = slave0_rx_valid;

    // Open-drain style bus resolution: the line is high unless one side pulls low.
    assign i2c_scl = master_scl_drive_low ? 1'b0 : 1'b1;
    assign i2c_sda = (master_sda_drive_low || slave0_sda_drive_low || slave1_sda_drive_low || slave2_sda_drive_low) ? 1'b0 : 1'b1;

    i2c_master_write #(
        .CLK_DIV(CLK_DIV)
    ) u_master (
        .clk(clk),
        .rst(rst),
        .start(start_write),
        .slave_addr(selected_addr),
        .payload(tx_data),
        .sda_in(i2c_sda),
        .scl_drive_low(master_scl_drive_low),
        .sda_drive_low(master_sda_drive_low),
        .busy(busy),
        .done(done),
        .ack_error(ack_error)
    );

    // Slaves sample SCL/SDA edges using clk for synchronous observation.
    i2c_slave_device #(
        .ADDRESS(SLAVE_ADDRESS)
    ) u_slave0 (
        .clk(clk),
        .rst(rst),
        .scl(i2c_scl),
        .sda(i2c_sda),
        .sda_drive_low(slave0_sda_drive_low),
        .rx_data(slave0_rx_data),
        .rx_valid(slave0_rx_valid)
    );

    i2c_slave_device #(
        .ADDRESS(SLAVE1_ADDRESS)
    ) u_slave1 (
        .clk(clk),
        .rst(rst),
        .scl(i2c_scl),
        .sda(i2c_sda),
        .sda_drive_low(slave1_sda_drive_low),
        .rx_data(slave1_rx_data),
        .rx_valid(slave1_rx_valid)
    );

    i2c_slave_device #(
        .ADDRESS(SLAVE2_ADDRESS)
    ) u_slave2 (
        .clk(clk),
        .rst(rst),
        .scl(i2c_scl),
        .sda(i2c_sda),
        .sda_drive_low(slave2_sda_drive_low),
        .rx_data(slave2_rx_data),
        .rx_valid(slave2_rx_valid)
    );
endmodule
