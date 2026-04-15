module uart_endpoint #(
    parameter integer BAUD_DIVISOR = 8
) (
    input wire clk,
    input wire rst,
    input wire send_strobe,
    input wire [7:0] send_data,
    input wire serial_in,
    output wire serial_out,
    output wire tx_busy,
    output wire tx_done,
    output wire [7:0] rx_data,
    output wire rx_valid,
    output wire rx_frame_error,
    output wire rx_busy
);
    wire baud_tick;

    uart_baud_gen #(
        .DIVISOR(BAUD_DIVISOR)
    ) u_baud_gen (
        .clk(clk),
        .rst(rst),
        .baud_tick(baud_tick)
    );

    uart_tx u_uart_tx (
        .clk(clk),
        .rst(rst),
        .baud_tick(baud_tick),
        .start(send_strobe),
        .data_in(send_data),
        .tx(serial_out),
        .busy(tx_busy),
        .done(tx_done)
    );

    uart_rx u_uart_rx (
        .clk(clk),
        .rst(rst),
        .baud_tick(baud_tick),
        .rx(serial_in),
        .data_out(rx_data),
        .data_valid(rx_valid),
        .frame_error(rx_frame_error),
        .busy(rx_busy)
    );
endmodule
