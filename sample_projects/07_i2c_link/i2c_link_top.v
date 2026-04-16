module i2c_link_top #(
    parameter integer CLK_DIV = 8,
    parameter [6:0] SLAVE_ADDRESS = 7'h42
) (
    input wire clk,
    input wire rst,
    input wire start_write,
    input wire [7:0] tx_data,
    output wire busy,
    output wire done,
    output wire ack_error,
    output wire [7:0] slave_rx_data,
    output wire slave_rx_valid,
    output wire i2c_scl,
    output wire i2c_sda
);
    wire master_scl_drive_low;
    wire master_sda_drive_low;
    wire slave_sda_drive_low;

    // Open-drain style bus resolution: the line is high unless one side pulls low.
    assign i2c_scl = master_scl_drive_low ? 1'b0 : 1'b1;
    assign i2c_sda = (master_sda_drive_low || slave_sda_drive_low) ? 1'b0 : 1'b1;

    i2c_master_write #(
        .CLK_DIV(CLK_DIV)
    ) u_master (
        .clk(clk),
        .rst(rst),
        .start(start_write),
        .slave_addr(SLAVE_ADDRESS),
        .payload(tx_data),
        .sda_in(i2c_sda),
        .scl_drive_low(master_scl_drive_low),
        .sda_drive_low(master_sda_drive_low),
        .busy(busy),
        .done(done),
        .ack_error(ack_error)
    );

    // The slave needs to sample SCL/SDA edges. In this simple model, use the same
    // simulation clock as the master to ensure edges are observed.
    i2c_slave_device #(
        .ADDRESS(SLAVE_ADDRESS)
    ) u_slave (
        .clk(clk),
        .rst(rst),
        .scl(i2c_scl),
        .sda(i2c_sda),
        .sda_drive_low(slave_sda_drive_low),
        .rx_data(slave_rx_data),
        .rx_valid(slave_rx_valid)
    );
endmodule
