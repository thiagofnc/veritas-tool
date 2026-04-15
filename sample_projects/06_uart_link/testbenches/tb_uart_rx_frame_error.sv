`timescale 1ns/1ps

module tb_uart_rx_frame_error;
    reg clk = 1'b0;
    reg rst = 1'b1;
    reg baud_tick = 1'b0;
    reg rx = 1'b1;

    wire [7:0] data_out;
    wire data_valid;
    wire frame_error;
    wire busy;

    uart_rx dut (
        .clk(clk),
        .rst(rst),
        .baud_tick(baud_tick),
        .rx(rx),
        .data_out(data_out),
        .data_valid(data_valid),
        .frame_error(frame_error),
        .busy(busy)
    );

    always #5 clk = ~clk;

    task automatic sample_bit(input reg bit_value);
        begin
            rx <= bit_value;
            baud_tick <= 1'b1;
            @(posedge clk);
            baud_tick <= 1'b0;
            @(posedge clk);
        end
    endtask

    task automatic send_frame(input [7:0] payload, input reg stop_bit);
        integer idx;
        begin
            sample_bit(1'b0);
            for (idx = 0; idx < 8; idx = idx + 1) begin
                sample_bit(payload[idx]);
            end
            sample_bit(stop_bit);
            rx <= 1'b1;
        end
    endtask

    initial begin
        $dumpfile("tb_uart_rx_frame_error.vcd");
        $dumpvars(0, tb_uart_rx_frame_error);

        repeat (4) @(posedge clk);
        rst <= 1'b0;
        @(posedge clk);

        send_frame(8'hc3, 1'b0);
        @(posedge clk);
        if (!frame_error) begin
            $display("ERROR: expected frame_error after invalid stop bit.");
            $finish;
        end
        if (data_valid) begin
            $display("ERROR: data_valid should stay low on a framing error.");
            $finish;
        end

        send_frame(8'h5a, 1'b1);
        @(posedge clk);
        if (frame_error) begin
            $display("ERROR: receiver did not recover after framing error.");
            $finish;
        end
        if (!data_valid) begin
            $display("ERROR: expected data_valid after a good frame.");
            $finish;
        end
        if (data_out !== 8'h5a) begin
            $display("ERROR: received 0x%02x, expected 0x5a.", data_out);
            $finish;
        end

        $display("PASS: UART RX flags framing errors and recovers.");
        #20;
        $finish;
    end
endmodule
