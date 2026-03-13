module comms_top (
    input wire clk,
    input wire rst,
    input wire start,
    input wire serial_rx,
    input wire spi_miso,
    input wire i2c_sda_in,
    output wire serial_tx,
    output wire spi_sclk,
    output wire spi_mosi,
    output wire spi_cs_n,
    output wire i2c_scl,
    output wire i2c_sda_out,
    output wire busy
);
    wire tick_16x;
    wire [7:0] tx_data;
    wire tx_start;
    wire [7:0] rx_data;
    wire rx_valid;
    wire [7:0] spi_wdata;
    wire spi_start;
    wire [7:0] spi_rdata;
    wire spi_done;
    wire [7:0] i2c_wdata;
    wire i2c_start;
    wire [7:0] i2c_rdata;
    wire i2c_done;

    baud_gen u_baud_gen (
        .clk(clk),
        .rst(rst),
        .tick_16x(tick_16x)
    );

    register_bank u_regs (
        .clk(clk),
        .rst(rst),
        .start(start),
        .uart_rx_data(rx_data),
        .uart_rx_valid(rx_valid),
        .spi_rdata(spi_rdata),
        .spi_done(spi_done),
        .i2c_rdata(i2c_rdata),
        .i2c_done(i2c_done),
        .tx_data(tx_data),
        .tx_start(tx_start),
        .spi_wdata(spi_wdata),
        .spi_start(spi_start),
        .i2c_wdata(i2c_wdata),
        .i2c_start(i2c_start),
        .busy(busy)
    );

    uart_tx u_uart_tx (
        .clk(clk),
        .rst(rst),
        .tick_16x(tick_16x),
        .data_in(tx_data),
        .start(tx_start),
        .tx(serial_tx)
    );

    uart_rx u_uart_rx (
        .clk(clk),
        .rst(rst),
        .tick_16x(tick_16x),
        .rx(serial_rx),
        .data_out(rx_data),
        .data_valid(rx_valid)
    );

    spi_master u_spi_master (
        .clk(clk),
        .rst(rst),
        .start(spi_start),
        .data_in(spi_wdata),
        .miso(spi_miso),
        .sclk(spi_sclk),
        .mosi(spi_mosi),
        .cs_n(spi_cs_n),
        .data_out(spi_rdata),
        .done(spi_done)
    );

    i2c_master u_i2c_master (
        .clk(clk),
        .rst(rst),
        .start(i2c_start),
        .data_in(i2c_wdata),
        .sda_in(i2c_sda_in),
        .scl(i2c_scl),
        .sda_out(i2c_sda_out),
        .data_out(i2c_rdata),
        .done(i2c_done)
    );
endmodule
