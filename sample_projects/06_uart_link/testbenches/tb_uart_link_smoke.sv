`timescale 1ns/1ps

module tb_uart_link_smoke;
    reg clk = 1'b0;
    reg rst = 1'b1;
    reg a_send = 1'b0;
    reg [7:0] a_data = 8'h00;
    reg b_send = 1'b0;
    reg [7:0] b_data = 8'h00;

    wire a_tx_busy;
    wire b_tx_busy;
    wire a_tx_done;
    wire b_tx_done;
    wire [7:0] a_rx_data;
    wire [7:0] b_rx_data;
    wire a_rx_valid;
    wire b_rx_valid;
    wire a_frame_error;
    wire b_frame_error;

    uart_link_top #(
        .BAUD_DIVISOR(4)
    ) dut (
        .clk(clk),
        .rst(rst),
        .a_send(a_send),
        .a_data(a_data),
        .b_send(b_send),
        .b_data(b_data),
        .a_tx_busy(a_tx_busy),
        .b_tx_busy(b_tx_busy),
        .a_tx_done(a_tx_done),
        .b_tx_done(b_tx_done),
        .a_rx_data(a_rx_data),
        .b_rx_data(b_rx_data),
        .a_rx_valid(a_rx_valid),
        .b_rx_valid(b_rx_valid),
        .a_frame_error(a_frame_error),
        .b_frame_error(b_frame_error)
    );

    always #5 clk = ~clk;

    task automatic send_from_a(input [7:0] payload);
        begin
            @(posedge clk);
            while (a_tx_busy) begin
                @(posedge clk);
            end
            a_data <= payload;
            a_send <= 1'b1;
            @(posedge clk);
            a_send <= 1'b0;
        end
    endtask

    task automatic send_from_b(input [7:0] payload);
        begin
            @(posedge clk);
            while (b_tx_busy) begin
                @(posedge clk);
            end
            b_data <= payload;
            b_send <= 1'b1;
            @(posedge clk);
            b_send <= 1'b0;
        end
    endtask

    task automatic expect_at_b(input [7:0] payload);
        integer cycles;
        begin
            cycles = 0;
            while (!b_rx_valid && cycles < 300) begin
                @(posedge clk);
                cycles = cycles + 1;
            end
            if (!b_rx_valid) begin
                $display("ERROR: timed out waiting for node B to receive 0x%02x", payload);
                $finish;
            end
            if (b_frame_error) begin
                $display("ERROR: unexpected frame error at node B");
                $finish;
            end
            if (b_rx_data !== payload) begin
                $display("ERROR: node B received 0x%02x, expected 0x%02x", b_rx_data, payload);
                $finish;
            end
        end
    endtask

    task automatic expect_at_a(input [7:0] payload);
        integer cycles;
        begin
            cycles = 0;
            while (!a_rx_valid && cycles < 300) begin
                @(posedge clk);
                cycles = cycles + 1;
            end
            if (!a_rx_valid) begin
                $display("ERROR: timed out waiting for node A to receive 0x%02x", payload);
                $finish;
            end
            if (a_frame_error) begin
                $display("ERROR: unexpected frame error at node A");
                $finish;
            end
            if (a_rx_data !== payload) begin
                $display("ERROR: node A received 0x%02x, expected 0x%02x", a_rx_data, payload);
                $finish;
            end
        end
    endtask

    initial begin
        $dumpfile("tb_uart_link_smoke.vcd");
        $dumpvars(0, tb_uart_link_smoke);

        repeat (4) @(posedge clk);
        rst <= 1'b0;

        send_from_a(8'h3c);
        expect_at_b(8'h3c);

        send_from_b(8'ha5);
        expect_at_a(8'ha5);

        $display("PASS: UART bidirectional smoke test completed.");
        #20;
        $finish;
    end
endmodule
