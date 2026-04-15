module uart_baud_gen #(
    parameter integer DIVISOR = 8
) (
    input wire clk,
    input wire rst,
    output reg baud_tick
);
    reg [15:0] counter;

    always @(posedge clk or posedge rst) begin
        if (rst) begin
            counter <= 16'd0;
            baud_tick <= 1'b0;
        end else if (counter == DIVISOR - 1) begin
            counter <= 16'd0;
            baud_tick <= 1'b1;
        end else begin
            counter <= counter + 16'd1;
            baud_tick <= 1'b0;
        end
    end
endmodule
