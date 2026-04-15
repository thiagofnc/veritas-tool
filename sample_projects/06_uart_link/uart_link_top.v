module uart_link_top #(
    parameter integer BAUD_DIVISOR = 8
) (
    input wire clk,
    input wire rst,
    input wire a_send,
    input wire [7:0] a_data,
    input wire b_send,
    input wire [7:0] b_data,
    output wire a_tx_busy,
    output wire b_tx_busy,
    output wire a_tx_done,
    output wire b_tx_done,
    output wire [7:0] a_rx_data,
    output wire [7:0] b_rx_data,
    output wire a_rx_valid,
    output wire b_rx_valid,
    output wire a_frame_error,
    output wire b_frame_error
);
    wire serial_a_to_b;
    wire serial_b_to_a;
    wire a_rx_busy;
    wire b_rx_busy;

    uart_endpoint #(
        .BAUD_DIVISOR(BAUD_DIVISOR)
    ) u_node_a (
        .clk(clk),
        .rst(rst),
        .send_strobe(a_send),
        .send_data(a_data),
        .serial_in(serial_b_to_a),
        .serial_out(serial_a_to_b),
        .tx_busy(a_tx_busy),
        .tx_done(a_tx_done),
        .rx_data(a_rx_data),
        .rx_valid(a_rx_valid),
        .rx_frame_error(a_frame_error),
        .rx_busy(a_rx_busy)
    );

    uart_endpoint #(
        .BAUD_DIVISOR(BAUD_DIVISOR)
    ) u_node_b (
        .clk(clk),
        .rst(rst),
        .send_strobe(b_send),
        .send_data(b_data),
        .serial_in(serial_a_to_b),
        .serial_out(serial_b_to_a),
        .tx_busy(b_tx_busy),
        .tx_done(b_tx_done),
        .rx_data(b_rx_data),
        .rx_valid(b_rx_valid),
        .rx_frame_error(b_frame_error),
        .rx_busy(b_rx_busy)
    );
endmodule
