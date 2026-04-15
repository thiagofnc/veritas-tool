module uart_tx (
    input wire clk,
    input wire rst,
    input wire baud_tick,
    input wire start,
    input wire [7:0] data_in,
    output reg tx,
    output reg busy,
    output reg done
);
    localparam [1:0] STATE_IDLE = 2'd0;
    localparam [1:0] STATE_START = 2'd1;
    localparam [1:0] STATE_DATA = 2'd2;
    localparam [1:0] STATE_STOP = 2'd3;

    reg [1:0] state;
    reg [7:0] shift_reg;
    reg [2:0] bit_index;
    reg pending;

    always @(posedge clk or posedge rst) begin
        if (rst) begin
            state <= STATE_IDLE;
            shift_reg <= 8'd0;
            bit_index <= 3'd0;
            pending <= 1'b0;
            tx <= 1'b1;
            busy <= 1'b0;
            done <= 1'b0;
        end else begin
            done <= 1'b0;

            if (start && !busy && !pending) begin
                shift_reg <= data_in;
                pending <= 1'b1;
            end

            if (baud_tick) begin
                case (state)
                    STATE_IDLE: begin
                        tx <= 1'b1;
                        busy <= 1'b0;
                        bit_index <= 3'd0;
                        if (pending) begin
                            state <= STATE_START;
                            pending <= 1'b0;
                            busy <= 1'b1;
                            tx <= 1'b0;
                        end
                    end

                    STATE_START: begin
                        state <= STATE_DATA;
                        tx <= shift_reg[0];
                        bit_index <= 3'd0;
                    end

                    STATE_DATA: begin
                        if (bit_index == 3'd7) begin
                            state <= STATE_STOP;
                            tx <= 1'b1;
                        end else begin
                            bit_index <= bit_index + 3'd1;
                            tx <= shift_reg[bit_index + 3'd1];
                        end
                    end

                    STATE_STOP: begin
                        state <= STATE_IDLE;
                        tx <= 1'b1;
                        busy <= 1'b0;
                        done <= 1'b1;
                    end

                    default: begin
                        state <= STATE_IDLE;
                        tx <= 1'b1;
                        busy <= 1'b0;
                    end
                endcase
            end
        end
    end
endmodule
