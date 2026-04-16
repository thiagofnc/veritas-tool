
`timescale 1ns/1ps

module tb_i2c_link;
    // Parameters
    parameter CLK_PERIOD = 10;  // 100MHz clock
    parameter CLK_DIV = 8;
    parameter [6:0] SLAVE_ADDRESS = 7'h42;

    // DUT signals
    reg clk;
    reg rst;
    reg start_write;
    reg [7:0] tx_data;
    wire busy;
    wire done;
    wire ack_error;
    wire [7:0] slave_rx_data;
    wire slave_rx_valid;
    wire i2c_scl;
    wire i2c_sda;

    // Test variables
    integer pass_count;
    integer fail_count;
    integer test_num;
    
    // Capture slave received data
    reg [7:0] captured_rx_data;
    reg captured_rx_valid;

    // Instantiate DUT
    i2c_link_top #(
        .CLK_DIV(CLK_DIV),
        .SLAVE_ADDRESS(SLAVE_ADDRESS)
    ) dut (
        .clk(clk),
        .rst(rst),
        .start_write(start_write),
        .tx_data(tx_data),
        .busy(busy),
        .done(done),
        .ack_error(ack_error),
        .slave_rx_data(slave_rx_data),
        .slave_rx_valid(slave_rx_valid),
        .i2c_scl(i2c_scl),
        .i2c_sda(i2c_sda)
    );

    // Clock generation
    initial begin
        clk = 0;
        forever #(CLK_PERIOD/2) clk = ~clk;
    end

    // Capture slave RX data when valid
    always @(posedge clk) begin
        if (rst) begin
            captured_rx_valid <= 0;
            captured_rx_data <= 8'h00;
        end else if (slave_rx_valid) begin
            captured_rx_valid <= 1;
            captured_rx_data <= slave_rx_data;
        end
    end

    // Task to perform a write transaction
    task i2c_write_transaction;
        input [7:0] data;
        input integer expected_ack_error;
        integer timeout_cnt;
        reg timeout_flag;
        begin
            test_num = test_num + 1;
            timeout_flag = 0;
            
            // Clear captured data
            captured_rx_valid = 0;
            captured_rx_data = 8'h00;
            
            tx_data = data;
            @(posedge clk);
            start_write = 1;
            @(posedge clk);
            start_write = 0;
            
            // Wait for busy to go high with timeout
            timeout_cnt = 0;
            while (!busy && timeout_cnt < 100) begin
                @(posedge clk);
                timeout_cnt = timeout_cnt + 1;
            end
            
            if (timeout_cnt >= 100) begin
                $display("FAIL [t=%0t] Test %0d: Timeout waiting for busy", $time, test_num);
                fail_count = fail_count + 1;
                timeout_flag = 1;
            end
            
            // Wait for transaction to complete with timeout
            if (!timeout_flag) begin
                timeout_cnt = 0;
                while (!done && timeout_cnt < 10000) begin
                    @(posedge clk);
                    timeout_cnt = timeout_cnt + 1;
                end
                
                if (timeout_cnt >= 10000) begin
                    $display("FAIL [t=%0t] Test %0d: Timeout waiting for done", $time, test_num);
                    fail_count = fail_count + 1;
                    timeout_flag = 1;
                end
            end
            
            // Only check results if no timeout
            if (!timeout_flag) begin
                // Give some time for slave to process
                repeat(10) @(posedge clk);
                
                // Check results
                if (expected_ack_error) begin
                    if (ack_error) begin
                        $display("PASS [t=%0t] Test %0d: ACK error detected as expected", $time, test_num);
                        pass_count = pass_count + 1;
                    end else begin
                        $display("FAIL [t=%0t] Test %0d: Expected ACK error but got none", $time, test_num);
                        fail_count = fail_count + 1;
                    end
                end else begin
                    if (!ack_error) begin
                        $display("PASS [t=%0t] Test %0d: No ACK error (as expected)", $time, test_num);
                        pass_count = pass_count + 1;
                    end else begin
                        $display("FAIL [t=%0t] Test %0d: Unexpected ACK error", $time, test_num);
                        fail_count = fail_count + 1;
                    end
                    
                    // Check received data
                    if (captured_rx_valid && captured_rx_data == data) begin
                        $display("PASS [t=%0t] Test %0d: Slave received correct data 0x%02h", $time, test_num, data);
                        pass_count = pass_count + 1;
                    end else if (!captured_rx_valid) begin
                        $display("FAIL [t=%0t] Test %0d: Slave did not receive valid data", $time, test_num);
                        fail_count = fail_count + 1;
                    end else begin
                        $display("FAIL [t=%0t] Test %0d: Slave received 0x%02h, expected 0x%02h", 
                                 $time, test_num, captured_rx_data, data);
                        fail_count = fail_count + 1;
                    end
                end
            end
        end
    endtask

    // Task to wait for idle
    task wait_idle;
        integer timeout_cnt;
        begin
            timeout_cnt = 0;
            while (busy && timeout_cnt < 10000) begin
                @(posedge clk);
                timeout_cnt = timeout_cnt + 1;
            end
            repeat(10) @(posedge clk);
        end
    endtask

    // Main test sequence
    initial begin
        // Initialize
        pass_count = 0;
        fail_count = 0;
        test_num = 0;
        rst = 1;
        start_write = 0;
        tx_data = 8'h00;
        
        // Apply reset
        repeat(5) @(posedge clk);
        rst = 0;
        repeat(5) @(posedge clk);
        
        $display("========================================");
        $display("    I2C Link Comprehensive Test Suite");
        $display("========================================");
        
        // Test 1: Basic write transaction with simple data
        $display("\n--- Test 1: Write 0xAA ---");
        i2c_write_transaction(8'hAA, 0);
        wait_idle();
        
        // Test 2: Write all zeros
        $display("\n--- Test 2: Write 0x00 ---");
        i2c_write_transaction(8'h00, 0);
        wait_idle();
        
        // Test 3: Write all ones
        $display("\n--- Test 3: Write 0xFF ---");
        i2c_write_transaction(8'hFF, 0);
        wait_idle();
        
        // Test 4: Write alternating pattern
        $display("\n--- Test 4: Write 0x55 ---");
        i2c_write_transaction(8'h55, 0);
        wait_idle();
        
        // Test 5-12: Write various values
        $display("\n--- Test 5: Write 0x12 ---");
        i2c_write_transaction(8'h12, 0);
        wait_idle();
        
        $display("\n--- Test 6: Write 0x34 ---");
        i2c_write_transaction(8'h34, 0);
        wait_idle();
        
        $display("\n--- Test 7: Write 0x56 ---");
        i2c_write_transaction(8'h56, 0);
        wait_idle();
        
        $display("\n--- Test 8: Write 0x78 ---");
        i2c_write_transaction(8'h78, 0);
        wait_idle();
        
        $display("\n--- Test 9: Write 0x9A ---");
        i2c_write_transaction(8'h9A, 0);
        wait_idle();
        
        $display("\n--- Test 10: Write 0xBC ---");
        i2c_write_transaction(8'hBC, 0);
        wait_idle();
        
        $display("\n--- Test 11: Write 0xDE ---");
        i2c_write_transaction(8'hDE, 0);
        wait_idle();
        
        $display("\n--- Test 12: Write 0xF0 ---");
        i2c_write_transaction(8'hF0, 0);
        wait_idle();
        
        // Test 13-14: Back-to-back transactions
        $display("\n--- Test 13: Back-to-back write 0xAB ---");
        i2c_write_transaction(8'hAB, 0);
        wait_idle();
        
        $display("\n--- Test 14: Back-to-back write 0xCD ---");
        i2c_write_transaction(8'hCD, 0);
        wait_idle();
        
        // Test 15: Edge case - 0x01
        $display("\n--- Test 15: Write 0x01 ---");
        i2c_write_transaction(8'h01, 0);
        wait_idle();
        
        // Test 16: Edge case - 0xFE
        $display("\n--- Test 16: Write 0xFE ---");
        i2c_write_transaction(8'hFE, 0);
        wait_idle();
        
        // Test 17: Edge case - 0x80
        $display("\n--- Test 17: Write 0x80 ---");
        i2c_write_transaction(8'h80, 0);
        wait_idle();
        
        // Test 18: Edge case - 0x7F
        $display("\n--- Test 18: Write 0x7F ---");
        i2c_write_transaction(8'h7F, 0);
        wait_idle();
        
        // Test 19: Reset behavior
        $display("\n--- Test 19: Reset behavior ---");
        rst = 1;
        repeat(3) @(posedge clk);
        rst = 0;
        repeat(3) @(posedge clk);
        
        if (!busy && !done && !ack_error) begin
            $display("PASS [t=%0t] Reset cleared all outputs correctly", $time);
            pass_count = pass_count + 1;
        end else begin
            $display("FAIL [t=%0t] Reset did not clear outputs (busy=%b, done=%b, ack_error=%b)", 
                     $time, busy, done, ack_error);
            fail_count = fail_count + 1;
        end
        
        // Test 20: Verify idle state
        $display("\n--- Test 20: Verify idle state ---");
        repeat(10) @(posedge clk);
        if (!busy && !done && !ack_error) begin
            $display("PASS [t=%0t] System idle state verified", $time);
            pass_count = pass_count + 1;
        end else begin
            $display("FAIL [t=%0t] System not in idle state", $time);
            fail_count = fail_count + 1;
        end
        
        // Test 21: Quick succession write
        $display("\n--- Test 21: Quick succession write 0xEF ---");
        i2c_write_transaction(8'hEF, 0);
        wait_idle();
        
        // Final summary
        repeat(10) @(posedge clk);
        $display("\n========================================");
        $display("           Test Summary");
        $display("========================================");
        $display("  Total Tests Run: %0d", test_num);
        $display("  PASS: %0d", pass_count);
        $display("  FAIL: %0d", fail_count);
        $display("========================================");
        
        if (fail_count == 0) begin
            $display("\n*** All tests PASSED! ***\n");
        end else begin
            $display("\n*** Some tests FAILED! ***\n");
        end
        
        $finish;
    end

    // Timeout watchdog
    initial begin
        #1000000;  // 1ms timeout
        $display("FAIL [t=%0t] Testbench timeout!", $time);
        $finish;
    end

    // Optional: Monitor I2C bus activity
    initial begin
        $dumpfile("i2c_link.vcd");
        $dumpvars(0, tb_i2c_link);
    end

endmodule
